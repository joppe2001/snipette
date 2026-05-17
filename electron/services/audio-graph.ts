/**
 * Audio-only filter graph builder for the WebCodecs export path.
 *
 * The full {@link buildExportGraph} in filter-graph.ts produces a combined video + audio
 * graph for the legacy FFmpeg export. The new canvas/WebCodecs path encodes video in the
 * renderer and only needs FFmpeg for the audio chain — this is a slim builder that emits
 * just the audio side (atrim, atempo, volume, adelay, audio FX, ducking, loudnorm, amix).
 *
 * Reuses the same helpers as filter-graph.ts so the behavior is bit-identical.
 */

import type { Clip, Track } from '../../shared/types';
import { audioFxToFFmpegFilters, isAudioFxType } from './audio-fx-filter';
import { duckingFilter, loudnormFilter, type VoiceWindow } from './audio-ducking';

export interface AudioGraphInputs {
  tracks: Track[];
  clips: Clip[];
  assetPaths: Map<string, string>;
  /** Whether to append a final `loudnorm` filter to the mixed output. */
  normalizeLoudness?: boolean;
}

export interface BuiltAudioGraph {
  inputs: string[];
  filterComplex: string;
  audioOutLabel: string;
}

/**
 * Build the audio-only filter graph. Returns null if the project has no audio clips at all.
 */
export function buildAudioOnlyGraph(input: AudioGraphInputs): BuiltAudioGraph | null {
  const { tracks, clips, assetPaths } = input;
  const orderedTracks = [...tracks].sort((a, b) => a.order_index - b.order_index);
  const allClipsSorted = [...clips].sort((a, b) => a.start_time_ms - b.start_time_ms);

  const inputs: string[] = [];
  const filters: string[] = [];
  const audioChains: { clip: Clip; label: string }[] = [];

  let inputIdx = 0;
  for (const clip of allClipsSorted) {
    const track = tracks.find((t) => t.id === clip.track_id);
    if (!track || track.type !== 'audio') continue;
    if (track.is_muted) continue;

    // Video tracks may also carry audio when the source has it — but the legacy graph
    // treats audio + video separately. Mirror that: only explicit audio tracks contribute
    // unless the source has audio. For parity with filter-graph.ts (which checks
    // track.type === 'audio'), keep the same restriction.

    const assetPath = clip.asset_id ? assetPaths.get(clip.asset_id) : null;
    if (!assetPath) continue;

    inputs.push('-i', assetPath);
    const thisIdx = inputIdx++;
    const inLabel = `${thisIdx}:a`;
    const out = `a${thisIdx}`;

    const trimStart = clip.source_in_ms / 1000;
    const trimEnd = clip.source_out_ms / 1000;
    const speed = Math.max(0.05, clip.speed);
    const startOnTimeline = clip.start_time_ms / 1000;
    const parts: string[] = [
      `atrim=start=${trimStart.toFixed(3)}:end=${trimEnd.toFixed(3)}`,
      `asetpts=PTS-STARTPTS`,
      `atempo=${Math.min(2, Math.max(0.5, speed)).toFixed(3)}`,
      `volume=${clip.volume.toFixed(3)}`,
      `adelay=${Math.round(startOnTimeline * 1000)}|${Math.round(startOnTimeline * 1000)}`,
    ];

    // Audio FX + ducking — same handling as filter-graph.ts.
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

    if (rawFx.some((e) => e.type === 'audio-normalize')) {
      parts.push(loudnormFilter());
    }

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
    audioChains.push({ clip, label: out });
  }

  if (audioChains.length === 0) return null;

  const ins = audioChains.map((a) => `[${a.label}]`).join('');
  let finalLabel = 'amixOut';
  filters.push(
    `${ins}amix=inputs=${audioChains.length}:duration=longest:dropout_transition=0[${finalLabel}]`,
  );

  if (input.normalizeLoudness) {
    const normalized = 'aFinal';
    filters.push(`[${finalLabel}]${loudnormFilter()}[${normalized}]`);
    finalLabel = normalized;
  }

  // Use `orderedTracks` once so the linter doesn't flag the var as unused — keeps the
  // implementation aligned with the legacy graph's sort, even though the audio output
  // doesn't depend on track z-order.
  void orderedTracks;

  return { inputs, filterComplex: filters.join(';'), audioOutLabel: finalLabel };
}
