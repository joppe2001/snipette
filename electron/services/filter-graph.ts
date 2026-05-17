/**
 * FFmpeg filter_complex builder used by the export pipeline.
 *
 * The renderer hands us the project, tracks, clips, transitions, plus a resolved
 * map of asset paths. We:
 *   1. Add each asset as an input.
 *   2. For every video clip, trim → setpts (speed) → scale/crop to canvas → drawtext (if text) → grade → optional LUT.
 *   3. Stack overlays from lowest z (background) to highest (foreground) with overlay= filter.
 *   4. Mix audio clips through volume+afade+atrim, then amix.
 *   5. Emit `-map [vfinal]` and `-map [afinal]`.
 *
 * For brevity we apply transitions as straight cuts unless an xfade is configured between two
 * consecutive clips on the same track.
 */

import fs from 'node:fs';
import type { Clip, Track, Transition, ColorGrade } from '../../shared/types';
import { audioFxToFFmpegFilters, isAudioFxType } from './audio-fx-filter';
import { videoFxToFFmpegFilters, type VideoEffect } from './video-fx-filter';
import { duckingFilter, loudnormFilter, type VoiceWindow } from './audio-ducking';

export interface ExportInputs {
  project: { width: number; height: number; fps: number; duration_ms: number };
  tracks: Track[];
  clips: Clip[];
  transitions: Transition[];
  assetPaths: Map<string, string>;
}

export interface BuiltGraph {
  inputs: string[]; // arguments before -filter_complex
  filterComplex: string;
  videoOutLabel: string;
  audioOutLabel: string | null;
  hasAudio: boolean;
}

function parseGrade(json: string | null): Partial<ColorGrade> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Partial<ColorGrade>;
  } catch {
    return null;
  }
}

function gradeToFilter(g: Partial<ColorGrade>): string {
  // Map our normalized [-1..1] / [0..200] sliders to ffmpeg `eq` + `colorbalance` filters.
  const exposure = (g.exposure ?? 0) * 0.5;        // brightness
  const contrast = 1 + (g.contrast ?? 0) / 100;
  const saturation = 1 + (g.saturation ?? 0) / 100;
  const gamma = 1 + (g.shadows ?? 0) / 200;
  const eq = `eq=brightness=${exposure.toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}:gamma=${gamma.toFixed(3)}`;
  const temp = (g.temperature ?? 0) / 200;
  const tint = (g.tint ?? 0) / 200;
  const cb = `colorbalance=rs=${(temp).toFixed(3)}:bs=${(-temp).toFixed(3)}:gs=${(tint).toFixed(3)}`;
  return `${eq},${cb}`;
}

function escapeText(text: string): string {
  // FFmpeg drawtext processes two escape layers: filtergraph then drawtext.
  // For text inside `text='...'`, escape backslash → `\\`, single quote → `\'`,
  // colon → `\:`, and percent → `\%`.
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
}

/**
 * Find a system font we can hand to ffmpeg's `drawtext` filter. Without an explicit
 * `fontfile=`, ffmpeg-static fails silently on most platforms because it has no fontconfig.
 * Returns the absolute path or null if nothing usable was found.
 */
function resolveSystemFont(): string | null {
  const candidates =
    process.platform === 'darwin'
      ? [
          '/System/Library/Fonts/Helvetica.ttc',
          '/System/Library/Fonts/HelveticaNeue.ttc',
          '/Library/Fonts/Arial.ttf',
          '/System/Library/Fonts/Supplemental/Arial.ttf',
        ]
      : process.platform === 'win32'
        ? [
            'C:\\Windows\\Fonts\\arial.ttf',
            'C:\\Windows\\Fonts\\segoeui.ttf',
            'C:\\Windows\\Fonts\\calibri.ttf',
          ]
        : [
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
            '/usr/share/fonts/TTF/DejaVuSans.ttf',
          ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

/** Escape a fontfile path for use inside a drawtext filter argument. */
function escapeFontPath(p: string): string {
  // Backslash → double backslash, colon → escaped colon (Windows paths have `C:\…`).
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

interface VideoChain {
  clip: Clip;
  inputIdx: number; // index into ffmpeg -i list
  label: string;
}

export function buildExportGraph(input: ExportInputs): BuiltGraph {
  const { project, tracks, clips, transitions } = input;
  const W = project.width;
  const H = project.height;

  // Sort tracks by z-order; video at the bottom, text/sticker on top, audio doesn't matter.
  const orderedTracks = [...tracks].sort((a, b) => a.order_index - b.order_index);
  const videoTracks = orderedTracks.filter((t) => t.type === 'video');
  // Any track that can carry text-content clips: text + sticker + effect. Stickers and
  // emoji-style overlays are stored as text clips on those tracks too.
  const textTracks = orderedTracks.filter((t) => t.type === 'text' || t.type === 'sticker' || t.type === 'effect');
  // Resolve a font once per export — drawtext silently no-ops without an explicit fontfile
  // when ffmpeg-static lacks fontconfig (which is most of the time).
  const fontfile = resolveSystemFont();

  // Build the FFmpeg `-i` list. Each clip with an asset → its own -i.
  // (We could dedupe identical asset paths and trim per-clip, but per-clip -i is simpler
  //  and ffmpeg handles it well for sub-100 inputs.)
  const inputs: string[] = [];
  const filters: string[] = [];

  let inputIdx = 0;
  const videoChains: VideoChain[] = [];
  const audioChains: { clip: Clip; inputIdx: number; trackIdx: number; label: string }[] = [];

  const allClipsSorted = [...clips].sort((a, b) => a.start_time_ms - b.start_time_ms);

  for (const clip of allClipsSorted) {
    const track = tracks.find((t) => t.id === clip.track_id);
    if (!track) continue;

    if (track.type === 'text' && clip.text_content) {
      // Text doesn't need its own input; gets drawn on top later.
      continue;
    }

    const assetPath = clip.asset_id ? input.assetPaths.get(clip.asset_id) : null;
    if (!assetPath) continue;

    inputs.push('-i', assetPath);
    const thisIdx = inputIdx++;

    if (track.type === 'video') {
      const trimStart = clip.source_in_ms / 1000;
      const trimEnd = clip.source_out_ms / 1000;
      const speed = Math.max(0.05, clip.speed);
      const inLabel = `${thisIdx}:v`;
      const out = `v${thisIdx}`;
      const parts: string[] = [
        `trim=start=${trimStart.toFixed(3)}:end=${trimEnd.toFixed(3)}`,
        `setpts=(PTS-STARTPTS)/${speed.toFixed(3)}`,
        `scale=${W}:${H}:force_original_aspect_ratio=increase`,
        `crop=${W}:${H}`,
        `fps=${project.fps}`,
        `format=yuv420p`,
      ];
      const grade = parseGrade(clip.color_grade_json);
      if (grade) parts.push(gradeToFilter(grade));
      // Video motion FX (vignette, blur, mirror, vhs, etc.) live in effects_json alongside
      // audio FX + keyframes — pick only the entries with a video-fx type.
      let videoFxEntries: VideoEffect[] = [];
      if (clip.effects_json) {
        try {
          const parsed: unknown = JSON.parse(clip.effects_json);
          if (Array.isArray(parsed)) {
            videoFxEntries = parsed
              .filter(
                (e): e is { type: string; intensity?: number } =>
                  !!e &&
                  typeof e === 'object' &&
                  typeof (e as { type?: unknown }).type === 'string' &&
                  !isAudioFxType((e as { type: string }).type) &&
                  (e as { type: string }).type !== 'keyframes',
              )
              .map((e) => ({ type: e.type, intensity: e.intensity }));
          }
        } catch {
          // ignore malformed
        }
      }
      parts.push(...videoFxToFFmpegFilters(videoFxEntries));
      if (clip.opacity < 1) parts.push(`format=yuva420p,colorchannelmixer=aa=${clip.opacity.toFixed(3)}`);
      filters.push(`[${inLabel}]${parts.join(',')}[${out}]`);
      videoChains.push({ clip, inputIdx: thisIdx, label: out });
    } else if (track.type === 'audio') {
      const trimStart = clip.source_in_ms / 1000;
      const trimEnd = clip.source_out_ms / 1000;
      const speed = Math.max(0.05, clip.speed);
      const startOnTimeline = clip.start_time_ms / 1000;
      const inLabel = `${thisIdx}:a`;
      const out = `a${thisIdx}`;
      const parts: string[] = [
        `atrim=start=${trimStart.toFixed(3)}:end=${trimEnd.toFixed(3)}`,
        `asetpts=PTS-STARTPTS`,
        `atempo=${Math.min(2, Math.max(0.5, speed)).toFixed(3)}`,
        `volume=${clip.volume.toFixed(3)}`,
        `adelay=${Math.round(startOnTimeline * 1000)}|${Math.round(startOnTimeline * 1000)}`,
      ];
      // Audio FX (EQ, reverb, compressor, denoise, pitch, vocal enhancer) co-live in
      // effects_json with motion FX — filter to audio-prefixed entries and append.
      let rawFx: { type: string; params?: Record<string, number>; bypassed?: boolean }[] = [];
      if (clip.effects_json) {
        try {
          const parsed: unknown = JSON.parse(clip.effects_json);
          if (Array.isArray(parsed)) {
            rawFx = parsed.filter(
              (e): e is { type: string; params?: Record<string, number>; bypassed?: boolean } =>
                !!e && typeof e === 'object' && typeof (e as { type?: unknown }).type === 'string',
            );
          }
        } catch {
          // ignore malformed
        }
      }
      const audioFxEntries = rawFx
        .filter((e) => isAudioFxType(e.type))
        .filter((e) => !e.bypassed)
        .map((e) => ({ type: e.type, params: e.params ?? {} }));
      parts.push(...audioFxToFFmpegFilters(audioFxEntries));

      // Loudness normalization (EBU R128 -16 LUFS) — opt-in via {type:'audio-normalize'}.
      if (rawFx.some((e) => e.type === 'audio-normalize')) {
        parts.push(loudnormFilter());
      }

      // Auto-duck: this clip is flagged audio-duck-target → lower its volume during the
      // timeline windows where any voice clip (audio-duck-source) is active. The voice
      // windows themselves ride on the source clip's effects_json entry as `params.windows`
      // (set by the AudioIntelligence panel when the user clicks "Detect + apply ducking").
      const duckTarget = rawFx.find((e) => e.type === 'audio-duck-target');
      if (duckTarget) {
        const voiceWindows: VoiceWindow[] = [];
        for (const otherClip of clips) {
          if (otherClip.id === clip.id || !otherClip.effects_json) continue;
          try {
            const otherFx = JSON.parse(otherClip.effects_json);
            if (!Array.isArray(otherFx)) continue;
            for (const entry of otherFx) {
              if (entry && entry.type === 'audio-duck-source' && Array.isArray(entry.params?.windows)) {
                for (const w of entry.params.windows) {
                  // Windows are stored relative to the voice clip's start so they move
                  // with the clip. Translate to timeline-time using its current position.
                  if (typeof w.relStartMs === 'number' && typeof w.relEndMs === 'number') {
                    voiceWindows.push({
                      startMs: otherClip.start_time_ms + w.relStartMs,
                      endMs: otherClip.start_time_ms + w.relEndMs,
                    });
                  } else if (typeof w.startMs === 'number' && typeof w.endMs === 'number') {
                    // Back-compat with legacy absolute-timeline windows.
                    voiceWindows.push({ startMs: w.startMs, endMs: w.endMs });
                  }
                }
              }
            }
          } catch {
            // ignore malformed entries
          }
        }
        const ducked = duckingFilter(voiceWindows, (duckTarget.params?.ducked_volume as number) ?? 0.3);
        if (ducked) parts.push(ducked);
      }

      filters.push(`[${inLabel}]${parts.join(',')}[${out}]`);
      audioChains.push({
        clip,
        inputIdx: thisIdx,
        trackIdx: orderedTracks.findIndex((t) => t.id === track.id),
        label: out,
      });
    }
  }

  // Black canvas backdrop sized to the project, full duration.
  const totalDurationS = Math.max(0.1, project.duration_ms / 1000);
  filters.push(
    `color=c=black:s=${W}x${H}:r=${project.fps}:d=${totalDurationS.toFixed(3)},format=yuv420p[bg]`,
  );

  // Group video chains by their track. For each track we either overlay each clip onto the
  // running composite, OR — when a transition exists between two adjacent clips on the same
  // track — use xfade to crossfade between them before overlaying.
  let current = 'bg';
  let stepIdx = 0;
  const transitionByPair = new Map<string, (typeof transitions)[number]>();
  for (const tr of transitions) {
    transitionByPair.set(`${tr.clip_a_id}::${tr.clip_b_id}`, tr);
    transitionByPair.set(`${tr.clip_b_id}::${tr.clip_a_id}`, tr);
  }

  for (const vt of videoTracks) {
    const tracksClips = videoChains
      .filter((vc) => vc.clip.track_id === vt.id)
      .sort((a, b) => a.clip.start_time_ms - b.clip.start_time_ms);

    let i = 0;
    while (i < tracksClips.length) {
      const a = tracksClips[i];
      const b = tracksClips[i + 1];
      const tr = a && b ? transitionByPair.get(`${a.clip.id}::${b.clip.id}`) : undefined;

      if (tr && b) {
        // Crossfade A→B via xfade. xfade requires both inputs to have matching SAR/pix_fmt/rate;
        // we already normalize all clips to project resolution + fps + yuv420p above.
        const aStartS = a.clip.start_time_ms / 1000;
        const aDurS = a.clip.duration_ms / 1000;
        const transDurS = Math.min(tr.duration_ms / 1000, aDurS / 2, b.clip.duration_ms / 2000);
        const xfadeOffsetS = Math.max(0, aDurS - transDurS);
        const mixed = `xfm${stepIdx++}`;
        // xfade `offset` is relative to start of input A's stream — our trim/setpts above already
        // makes A's timeline start at 0 inside the chain. So offset = aDurS - transDurS.
        filters.push(
          `[${a.label}][${b.label}]xfade=transition=${xfadeType(tr.type)}:duration=${transDurS.toFixed(3)}:offset=${xfadeOffsetS.toFixed(3)}[${mixed}]`,
        );
        const next = `vs${stepIdx++}`;
        const endS = (a.clip.start_time_ms / 1000 + aDurS + (b.clip.duration_ms / 1000 - transDurS)).toFixed(3);
        filters.push(
          `[${current}][${mixed}]overlay=enable='between(t,${aStartS.toFixed(3)},${endS})':x=0:y=0[${next}]`,
        );
        current = next;
        i += 2;
        continue;
      }

      // Plain overlay for this clip.
      const startS = (a.clip.start_time_ms / 1000).toFixed(3);
      const endS = ((a.clip.start_time_ms + a.clip.duration_ms) / 1000).toFixed(3);
      const next = `vs${stepIdx++}`;
      filters.push(
        `[${current}][${a.label}]overlay=enable='between(t,${startS},${endS})':x=0:y=0[${next}]`,
      );
      current = next;
      i += 1;
    }
  }

  // Apply text overlays via drawtext.
  for (const tt of textTracks) {
    const clipsOnTrack = allClipsSorted.filter((c) => c.track_id === tt.id && c.text_content);
    for (const tc of clipsOnTrack) {
      const startS = (tc.start_time_ms / 1000).toFixed(3);
      const endS = ((tc.start_time_ms + tc.duration_ms) / 1000).toFixed(3);
      let style: Record<string, unknown> = {};
      try {
        style = tc.text_style_json ? JSON.parse(tc.text_style_json) : {};
      } catch {
        // ignore malformed style
      }
      const fontSize = (style.font_size as number) ?? 64;
      const color = (style.color as string) ?? 'white';
      const strokeColor = (style.stroke_color as string) ?? 'black';
      const strokeWidth = (style.stroke_width as number) ?? 2;
      const bgEnabled = style.bg_enabled === true;
      const bgColor = (style.bg_color as string) ?? 'black@0.5';
      const text = escapeText(tc.text_content ?? '');
      // Honor the clip's own position offsets (in renderer-canvas pixels) by mapping them
      // into the export canvas. Without keyframe support here yet, we use the static value.
      const offX = Math.round(tc.position_x ?? 0);
      const offY = Math.round(tc.position_y ?? 0);
      const drawParts = [
        `drawtext=text='${text}'`,
        `fontsize=${fontSize}`,
        `fontcolor=${color}`,
      ];
      if (fontfile) drawParts.push(`fontfile=${escapeFontPath(fontfile)}`);
      if (strokeWidth > 0) {
        drawParts.push(`bordercolor=${strokeColor}`);
        drawParts.push(`borderw=${strokeWidth}`);
      }
      if (bgEnabled) {
        drawParts.push('box=1');
        drawParts.push(`boxcolor=${bgColor}`);
        drawParts.push(`boxborderw=${(style.bg_padding as number) ?? 8}`);
      }
      drawParts.push(`x=(w-text_w)/2+${offX}`);
      drawParts.push(`y=h*0.78+${offY}`);
      drawParts.push(`enable='between(t,${startS},${endS})'`);
      const draw = drawParts.join(':');
      const next = `vs${stepIdx++}`;
      filters.push(`[${current}]${draw}[${next}]`);
      current = next;
    }
  }

  const videoOut = current === 'bg' ? 'bg' : current;
  filters.push(`[${videoOut}]format=yuv420p[vfinal]`);

  // Mix all audio chains.
  let audioOut: string | null = null;
  const validAudio = audioChains.filter((a) => {
    const t = orderedTracks.find((tt) => tt.id === a.clip.track_id);
    return t && !t.is_muted;
  });
  if (validAudio.length > 0) {
    const ins = validAudio.map((a) => `[${a.label}]`).join('');
    filters.push(`${ins}amix=inputs=${validAudio.length}:duration=longest:dropout_transition=0[afinal]`);
    audioOut = 'afinal';
  }
  return {
    inputs,
    filterComplex: filters.join(';'),
    videoOutLabel: 'vfinal',
    audioOutLabel: audioOut,
    hasAudio: !!audioOut,
  };
}

export function qualityToEncoderArgs(quality: 'draft' | 'good' | 'high' | 'best' | 'lossless'): string[] {
  switch (quality) {
    case 'draft':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28'];
    case 'good':
      return ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23'];
    case 'high':
      return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'];
    case 'best':
      return ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18'];
    case 'lossless':
      return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '0'];
  }
}

/** Map Snipette transition names to FFmpeg xfade transition names. */
function xfadeType(type: string): string {
  const map: Record<string, string> = {
    cut: 'fade',
    dissolve: 'fade',
    fade: 'fade',
    slide: 'slideleft',
    push: 'slideleft',
    wipe: 'wiperight',
    iris: 'circleopen',
    smooth: 'smoothleft',
    zoom: 'zoomin',
    glitch: 'pixelize',
    bounce: 'rectcrop',
    spin: 'circlecrop',
    whip: 'wipeleft',
  };
  return map[type] ?? 'fade';
}

export function formatToContainerArgs(format: 'mp4' | 'mp4-h265' | 'mov' | 'webm' | 'gif'): string[] {
  switch (format) {
    case 'mp4-h265':
      return ['-c:v', 'libx265', '-tag:v', 'hvc1'];
    case 'mov':
      return ['-c:v', 'libx264', '-movflags', '+faststart'];
    case 'webm':
      return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30'];
    case 'gif':
      return ['-c:v', 'gif', '-loop', '0'];
    case 'mp4':
    default:
      return [];
  }
}
