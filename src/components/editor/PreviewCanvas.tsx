import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '@/components/ui/icons';
import { Slider } from '@/components/ui/Slider';
import { useProjectStore } from '@/store/project.store';
import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import { formatTimePair } from '@/utils/time';
import { fileUrl } from '@/utils/file';
import { gradeToCSS } from '@/utils/color';
import { computeTransitionStates, transitionFadeMultiplier, transitionWindow, type TransitionVisual } from '@/utils/transitions';
import {
  computeKaraokeWordStates,
  computeTextAnimation,
  parseTextAnimation,
} from '@/utils/text-animation';
import { computeMotionFx, parseEffects, type MotionEffect } from '@/utils/motion-fx';
import { parseKeyframes, valueAt, valuesAt, type KeyframeTracks } from '@/utils/keyframes';
import { textStyleToCss } from '@/utils/text-templates';
import { DEFAULT_TEXT_ANIM } from '@/utils/text-animation';
import { SN_TEXT_DESIGN_MIME, type TextDesignDragPayload } from '@/utils/text-design-drag';
import { syncAudioFxForClip, pruneAudioFx, teardownAudioFxForClip } from '@/utils/preview-audio-fx';
import { duckLevelAt, readDuckTarget, timelineWindowsForVoice, type TimelineWindow } from '@/utils/auto-duck';
import type { Clip, ColorGrade } from '@shared/types';

const CANVAS_RATIO: Record<string, { w: number; h: number }> = {
  '9:16': { w: 9, h: 16 },
  '16:9': { w: 16, h: 9 },
  '1:1': { w: 1, h: 1 },
};

/** Window (in ms) around the playhead inside which `<video>` / `<audio>` elements
 *  are mounted. Outside this window the media element is unmounted entirely, so
 *  Chromium's hardware decoder pool isn't exhausted on long projects. 1.5 s is
 *  enough lookahead for transitions + a little decode warm-up. */
const PREVIEW_MOUNT_WINDOW_MS = 1500;

function ratioFor(project: { format: string; width: number; height: number }) {
  if (project.format === 'custom') return { w: project.width, h: project.height };
  return CANVAS_RATIO[project.format] ?? { w: 16, h: 9 };
}

/** Native canvas resolution per format. Internal coordinates are in this space so
 *  text/clip positions stay valid no matter how the preview is resized on screen. */
function nativeResolution(project: { format: string; width: number; height: number }) {
  if (project.format === 'custom') return { w: project.width, h: project.height };
  if (project.format === '16:9') return { w: 1920, h: 1080 };
  if (project.format === '1:1') return { w: 1080, h: 1080 };
  return { w: 1080, h: 1920 }; // 9:16 default
}

/** Render-scale = on-screen px / native px. Drag handlers divide screen deltas by
 *  this to convert mouse movement back into native-space movement. */
export const PreviewScaleContext = createContext<number>(1);
export function usePreviewScale(): number {
  return useContext(PreviewScaleContext);
}

// ---------------------------------------------------------------------------
// Module-level JSON parse caches.
//
// `effects_json` and `text_style_json` are immutable strings — same input always
// parses to the same value — but the editor calls `parseKeyframes`/`parseEffects`
// dozens of times per frame across clips, overlays, and the per-RAF volume effect.
// Caching by string identity collapses that into a single parse per unique JSON.
// We use a small `Map<string, parsed>` keyed by the raw JSON string. The cache is
// bounded so a long editing session with lots of distinct effect-jsons doesn't
// grow unboundedly — when it hits MAX, we drop the oldest entries.
// ---------------------------------------------------------------------------
const MAX_CACHE = 256;

const keyframeCache = new Map<string, KeyframeTracks>();
function parseKeyframesCached(json: string | null | undefined): KeyframeTracks {
  if (!json) return parseKeyframes(json);
  const cached = keyframeCache.get(json);
  if (cached) return cached;
  const parsed = parseKeyframes(json);
  if (keyframeCache.size >= MAX_CACHE) {
    const firstKey = keyframeCache.keys().next().value;
    if (firstKey !== undefined) keyframeCache.delete(firstKey);
  }
  keyframeCache.set(json, parsed);
  return parsed;
}

const effectsCache = new Map<string, MotionEffect[]>();
function parseEffectsCached(json: string | null | undefined): MotionEffect[] {
  if (!json) return parseEffects(json);
  const cached = effectsCache.get(json);
  if (cached) return cached;
  const parsed = parseEffects(json);
  if (effectsCache.size >= MAX_CACHE) {
    const firstKey = effectsCache.keys().next().value;
    if (firstKey !== undefined) effectsCache.delete(firstKey);
  }
  effectsCache.set(json, parsed);
  return parsed;
}

const textStyleCache = new Map<string, Record<string, unknown>>();
function parseTextStyleCached(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  const cached = textStyleCache.get(json);
  if (cached) return cached;
  let parsed: Record<string, unknown> = {};
  try {
    const result = JSON.parse(json);
    if (result && typeof result === 'object') parsed = result as Record<string, unknown>;
  } catch {
    // ignore — return empty object
  }
  if (textStyleCache.size >= MAX_CACHE) {
    const firstKey = textStyleCache.keys().next().value;
    if (firstKey !== undefined) textStyleCache.delete(firstKey);
  }
  textStyleCache.set(json, parsed);
  return parsed;
}

/** Short-circuiting wrapper around `computeTransitionStates`. When there are no
 *  transitions at all (the common case) we skip the per-RAF recompute entirely
 *  and return a singleton empty-result. */
const EMPTY_TRANSITION_STATE: ReturnType<typeof computeTransitionStates> = {
  byClip: new Map(),
  forceRender: new Set(),
};
function computeTransitionStatesGuarded(
  playhead: number,
  clips: Clip[],
  transitions: Parameters<typeof computeTransitionStates>[2],
): ReturnType<typeof computeTransitionStates> {
  if (transitions.length === 0) return EMPTY_TRANSITION_STATE;
  return computeTransitionStates(playhead, clips, transitions);
}
function transitionFadeMultiplierGuarded(
  playhead: number,
  clips: Clip[],
  transitions: Parameters<typeof transitionFadeMultiplier>[2],
): number {
  if (transitions.length === 0) return 1;
  return transitionFadeMultiplier(playhead, clips, transitions);
}

/** Compute a duck multiplier for a music clip using a precomputed list of voice
 *  windows. Avoids re-parsing every voice clip's `effects_json` on every RAF tick
 *  (the original `duckMultiplierForMusic` re-walks all clips and JSON.parses each
 *  one, every call). The voiceWindows list is memoised at the canvas level so it
 *  only rebuilds when clips actually change. */
function duckMultiplierFromWindows(
  playheadMs: number,
  musicClip: Clip,
  voiceWindows: TimelineWindow[],
): number {
  if (voiceWindows.length === 0) return 1;
  const ducked = readDuckTarget(musicClip.effects_json);
  if (ducked === null) return 1;
  // Exclude windows owned by THIS clip — same semantics as the original helper.
  // In practice voice windows live on voice clips and music windows live on music
  // clips, so this is a defensive filter; cheap because windows are tagged with
  // their owner clip id.
  let level = duckLevelAt(playheadMs, voiceWindows, ducked);
  if (level > 1) level = 1;
  return level;
}

export function PreviewCanvas(): JSX.Element {
  const project = useProjectStore((s) => s.activeProject);
  const assets = useProjectStore((s) => s.assets);
  const clips = useTimelineStore((s) => s.clips);
  const tracks = useTimelineStore((s) => s.tracks);
  const transitions = useTimelineStore((s) => s.transitions);
  const playhead = useTimelineStore((s) => s.playheadMs);
  const isPlaying = useTimelineStore((s) => s.isPlaying);
  const durationMs = useTimelineStore((s) => s.durationMs);
  const togglePlay = useTimelineStore((s) => s.togglePlay);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const activeTool = useTimelineStore((s) => s.activeTool);
  const clearSelection = useTimelineStore((s) => s.clearSelection);
  // Used by the Text-Designer canvas drop handler — `addClip` for optimistic
  // insertion, `pushHistory` for undo, `selectClip` to highlight the new clip.
  const addClipLocal = useTimelineStore((s) => s.addClip);
  const pushHistoryAction = useTimelineStore((s) => s.pushHistory);
  const selectClipAction = useTimelineStore((s) => s.selectClip);
  const computeDurationAction = useTimelineStore((s) => s.computeDuration);
  const pushToast = useEditorStore((s) => s.pushToast);
  const showSafeZones = useEditorStore((s) => s.showSafeZones);
  const toggleSafeZones = useEditorStore((s) => s.toggleSafeZones);
  const toggleFullscreen = useEditorStore((s) => s.toggleFullscreenPreview);
  const previewVolume = useEditorStore((s) => s.previewVolume);
  const previewMuted = useEditorStore((s) => s.previewMuted);
  const setPreviewVolume = useEditorStore((s) => s.setPreviewVolume);
  const togglePreviewMuted = useEditorStore((s) => s.togglePreviewMuted);
  const [volumePopover, setVolumePopover] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasBox, setCanvasBox] = useState({ w: 0, h: 0 });
  // Holds both `<video>` and `<audio>` elements keyed by clip id — they share the
  // HTMLMediaElement API (play/pause/currentTime/volume), so one map is enough for both.
  const videoRefs = useRef<Map<string, HTMLMediaElement>>(new Map());

  useEffect(() => {
    if (!containerRef.current || !project) return;
    const observer = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el || !project) return;
      const ratio = ratioFor(project);
      const PAD = 64;
      const maxW = el.clientWidth - PAD;
      const maxH = el.clientHeight - PAD;
      let w = maxW;
      let h = (w * ratio.h) / ratio.w;
      if (h > maxH) {
        h = maxH;
        w = (h * ratio.w) / ratio.h;
      }
      setCanvasBox({ w, h });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [project]);

  // Memoised lookups so we don't repeatedly walk arrays during render or per-RAF effects.
  const assetsById = useMemo(() => {
    const m = new Map<string, import('@shared/types').MediaAsset>();
    for (const a of assets) m.set(a.id, a);
    return m;
  }, [assets]);
  const clipsById = useMemo(() => {
    const m = new Map<string, Clip>();
    for (const c of clips) m.set(c.id, c);
    return m;
  }, [clips]);

  // When clips are removed from the project, prune their live Web Audio FX chains.
  // Without this, deleted-clip BiquadFilter/DynamicsCompressor/Delay nodes stay in
  // the audio graph forever, still burning CPU on every audio frame. Keyed on the
  // clip-id set so it only runs when the set of clips actually changes — adds and
  // edits-in-place don't trigger it.
  const clipIdsKey = useMemo(() => clips.map((c) => c.id).sort().join('|'), [clips]);
  useEffect(() => {
    const active = new Set<string>();
    for (const c of clips) active.add(c.id);
    pruneAudioFx(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipIdsKey]);
  const trackOrderById = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tracks) m.set(t.id, t.order_index);
    return m;
  }, [tracks]);
  // Precompute the list of all voice-windows in timeline-time once per clips change.
  // The per-RAF volume effect then only does a single window-overlap check per duck
  // target — not an O(N) re-parse of every clip's effects_json each tick.
  const voiceWindows = useMemo<TimelineWindow[]>(() => {
    const out: TimelineWindow[] = [];
    for (const c of clips) {
      // Cheap fast path: only voice clips have an `audio-duck-source` entry. Skip
      // anything without effects_json before parsing.
      if (!c.effects_json) continue;
      if (!c.effects_json.includes('audio-duck-source')) continue;
      const ws = timelineWindowsForVoice(c);
      for (const w of ws) out.push(w);
    }
    return out;
  }, [clips]);

  // Compute transition visual state once per playhead tick. Short-circuits to a
  // singleton empty result when there are no transitions (the common case),
  // bypassing the per-clip computation entirely.
  const transitionState = useMemo(
    () => computeTransitionStatesGuarded(playhead, clips, transitions),
    [playhead, clips, transitions],
  );
  // V-shape fade multiplier for text/sticker overlays that opted into following the
  // adjacent video transition. 1 when no transition is happening.
  const txnFadeMult = useMemo(
    () => transitionFadeMultiplierGuarded(playhead, clips, transitions),
    [playhead, clips, transitions],
  );

  // A clip renders if it's in its own time range OR if a transition is forcing it on screen
  // (e.g. the incoming clip during the first half of a transition window — playhead hasn't
  // reached its `start_time_ms` yet). We TIGHTEN to a small window around the playhead so
  // <video> elements far from the cursor are unmounted entirely — Chromium's hardware
  // decoder pool tops out around ~16 simultaneous streams on macOS, and exceeding it forces
  // software decode that pegs the CPU. 1.5 s of lookahead/lookbehind is plenty for
  // transitions to pre-warm without paying decoder cost for the whole project.
  const activeClips = useMemo(() => {
    const windowStart = playhead - PREVIEW_MOUNT_WINDOW_MS;
    const windowEnd = playhead + PREVIEW_MOUNT_WINDOW_MS;
    // Long transitions need BOTH clips mounted with enough lead time for the
    // <video> elements to decode the first frame. Pre-mount any clip referenced
    // by a transition whose window overlaps an extended ~3s lookahead — that way
    // a 2-3s wipe/dissolve starts with the incoming clip already decoded.
    const TRANSITION_PREMOUNT_MS = PREVIEW_MOUNT_WINDOW_MS * 2;
    const txnPremount = new Set<string>();
    for (const tr of transitions) {
      const a = clipsById.get(tr.clip_a_id);
      const b = clipsById.get(tr.clip_b_id);
      if (!a || !b) continue;
      const w = transitionWindow(tr, a, b);
      const nearStart = w.startMs - TRANSITION_PREMOUNT_MS;
      const nearEnd = w.endMs + TRANSITION_PREMOUNT_MS;
      if (playhead >= nearStart && playhead <= nearEnd) {
        txnPremount.add(a.id);
        txnPremount.add(b.id);
      }
    }
    return clips.filter((c) => {
      const clipEnd = c.start_time_ms + c.duration_ms;
      const overlapsWindow = clipEnd > windowStart && c.start_time_ms < windowEnd;
      return overlapsWindow || transitionState.forceRender.has(c.id) || txnPremount.has(c.id);
    });
  }, [clips, clipsById, transitions, playhead, transitionState]);

  // Pause-on-mount default — every newly-mounted element starts paused. The actual
  // play/pause state is driven per-RAF by the volume-sync effect below, which knows
  // whether the playhead is inside a clip's live window. Doing it that way ensures
  // pre-mounted warm-up clips stay silent and don't consume decode budget until
  // they're needed.
  useEffect(() => {
    if (!isPlaying) {
      for (const [, el] of videoRefs.current) el.pause();
    }
  }, [isPlaying]);

  // Force a seek when the playhead deviates from the video's natural currentTime by more than
  // 250 ms — that catches scrubs/jumps but lets the <video> element drive frame timing during
  // normal playback (overwriting currentTime every RAF tick causes black frames + decoder thrash).
  //
  // Special case: when a clip is rendered ONLY because it's the incoming side of a transition
  // (playhead < clip.start_time_ms), clamp its currentTime to source_in_ms so we show that
  // clip's opening frame, not whatever would correspond to a negative offset.
  useEffect(() => {
    for (const [clipId, el] of videoRefs.current) {
      const clip = clipsById.get(clipId);
      if (!clip) continue;
      const inOwnRange = playhead >= clip.start_time_ms && playhead < clip.start_time_ms + clip.duration_ms;
      const offset = playhead - clip.start_time_ms;
      // Where to park currentTime when the clip isn't actively playing matters a
      // lot for transitions: an outgoing clip past its end MUST hold at source_out
      // (its last frame), not snap back to source_in — otherwise the source file
      // restarts and the user hears clip-1's intro audio loop during the fade.
      // The three regions:
      //   playhead < clip.start  → incoming, hold first frame at source_in
      //   inOwnRange              → normal playback, source_in + offset*speed
      //   playhead >= clip.end    → outgoing, hold last frame at source_out
      let sourceTimeS: number;
      if (inOwnRange) {
        sourceTimeS = (clip.source_in_ms + offset * clip.speed) / 1000;
      } else if (playhead < clip.start_time_ms) {
        sourceTimeS = clip.source_in_ms / 1000;
      } else {
        sourceTimeS = clip.source_out_ms / 1000;
      }
      const drift = Math.abs(el.currentTime - sourceTimeS);
      if (drift > 0.25) {
        try {
          el.currentTime = sourceTimeS;
        } catch {
          /* Will resolve once metadata loads. */
        }
      }
      // Fast path: no keyframed effects means raw clip.volume / clip.speed apply
      // directly without parsing anything.
      let baseVol = clip.volume;
      let speed = clip.speed;
      if (clip.effects_json) {
        const kfTracksLocal = parseKeyframesCached(clip.effects_json);
        const rel = playhead - clip.start_time_ms;
        const v = valueAt(kfTracksLocal, 'volume', rel);
        if (v !== null && v !== undefined) baseVol = v;
        const s = valueAt(kfTracksLocal, 'speed', rel);
        if (s !== null && s !== undefined) speed = s;
      }
      // Live auto-duck: only run when there's at least one voice window AND this
      // clip is actually a duck-target. The voiceWindows array is precomputed
      // once per clips change, so this is O(windows) — no JSON re-parsing.
      const duckMult = voiceWindows.length > 0
        ? duckMultiplierFromWindows(playhead, clip, voiceWindows)
        : 1;
      // AUDIO follows TIME-range strictly — transitions only fade the picture, not
      // the sound (standard NLE behavior; if the user wants an audio crossfade
      // they add explicit audio fade keyframes). This keeps audio cuts crisp and
      // prevents both "next clip starts before its time" and "outgoing clip
      // continues playing past its end" bugs.
      //
      // VIDEO is still mounted/decoded for transition lookahead (handled by
      // activeClips), but stays paused + muted outside the clip's own range.
      el.volume = inOwnRange ? Math.min(1, baseVol * duckMult) * previewVolume : 0;
      el.muted = previewMuted || !inOwnRange;
      el.playbackRate = Math.max(0.25, Math.min(4, speed));
      if (isPlaying && inOwnRange) {
        if (el.paused) {
          void el.play().catch(() => {
            /* Autoplay may be blocked until a user gesture happens. */
          });
        }
      } else if (!el.paused) {
        el.pause();
      }
      // Sync the real-time audio FX chain for this element. The helper is a no-op when
      // the FX list hasn't changed, so this is safe to call on every playhead tick.
      // Without it audio FX (EQ, compressor, vocal enhancer) would be export-only and
      // invisible during preview.
      syncAudioFxForClip(clip.id, el, clip.effects_json);
    }
  }, [playhead, clipsById, voiceWindows, previewVolume, previewMuted, isPlaying, transitionState]);

  /**
   * Text-Designer drop handler. Reads the SN_TEXT_DESIGN_MIME payload, converts
   * the drop coordinates to native-canvas pixels, and creates a new text clip
   * at the current playhead with `position_x`/`position_y` matching where the
   * user dropped (relative to the text overlay's anchor at `left:50%, bottom:12%`).
   *
   * Finds or falls back to the first text track. If no text track exists we
   * surface a toast — track creation requires user confirmation via Layers.
   */
  const handleTextDesignDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    if (!project) return;
    const raw = e.dataTransfer.getData(SN_TEXT_DESIGN_MIME);
    if (!raw) return;
    let payload: TextDesignDragPayload;
    try {
      payload = JSON.parse(raw) as TextDesignDragPayload;
    } catch {
      return;
    }
    // Resolve the target text track. The user typically expects the drop to
    // land on the FIRST text track if multiple exist — matches the
    // dropHook/dropCompound pattern in TextInspector.
    const textTrack = useTimelineStore.getState().tracks.find((t) => t.type === 'text');
    if (!textTrack) {
      pushToast({ kind: 'error', message: 'Add a text track first.' });
      return;
    }

    // Translate the drop position into native-canvas pixels. The canvas div
    // was rendered at native resolution and transformed via CSS `scale`, so
    // the bounding rect width is `native.w * renderScale` — divide back out.
    const nr = nativeResolution(project);
    const rect = e.currentTarget.getBoundingClientRect();
    const s = canvasBox.w > 0 ? canvasBox.w / nr.w : 1;
    const localX = (e.clientX - rect.left) / s;
    const localY = (e.clientY - rect.top) / s;
    // Text overlays anchor at left:50%, bottom:12% — their position_x/_y are
    // offsets in NATIVE px from that anchor. Convert the drop point accordingly.
    const anchorX = nr.w / 2;
    const anchorY = nr.h * (1 - 0.12);
    const positionX = Math.round(localX - anchorX);
    const positionY = Math.round(localY - anchorY);

    const playheadMs = useTimelineStore.getState().playheadMs;
    pushHistoryAction();
    try {
      const created = await window.snipette.timeline.addClip(textTrack.id, {
        track_id: textTrack.id,
        project_id: project.id,
        start_time_ms: Math.max(0, playheadMs),
        duration_ms: payload.durationMs,
        source_in_ms: 0,
        source_out_ms: payload.durationMs,
        text_content: payload.text,
        text_style_json: JSON.stringify(payload.style),
      });
      // ClipCreate doesn't carry position / animation — apply them via update so
      // the new clip lands at the drop position with the designer's animation.
      const positioned = await window.snipette.timeline.updateClip(created.id, {
        position_x: positionX,
        position_y: positionY,
        text_animation_json: JSON.stringify({ ...DEFAULT_TEXT_ANIM, ...payload.animation }),
      });
      addClipLocal(positioned);
      selectClipAction(positioned.id);
      computeDurationAction();
      pushToast({ kind: 'success', message: 'Text placed on canvas.' });
    } catch (err) {
      pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not place text.',
      });
    }
  };

  if (!project) return <div />;

  const canvasRatio = ratioFor(project);
  // Render at a STABLE native resolution; resize on screen by CSS transform only.
  // This keeps text positions, font sizes, and clip transforms valid regardless of
  // the actual visible preview size.
  const native = nativeResolution(project);
  const renderScale = canvasBox.w > 0 ? canvasBox.w / native.w : 1;

  return (
    <div
      ref={containerRef}
      className="sn-checker"
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRight: '1px solid var(--border-subtle)',
        borderLeft: '1px solid var(--border-subtle)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: canvasBox.w,
          height: canvasBox.h,
          borderRadius: 8,
          overflow: 'hidden',
          boxShadow: '0 0 40px rgba(200,242,58,0.06), 0 24px 64px rgba(0,0,0,0.6)',
          background: '#000',
        }}
      >
      <PreviewScaleContext.Provider value={renderScale}>
      <div
        data-preview-canvas=""
        onClick={(e) => {
          // Click on bare canvas (not on a clip) — clear selection.
          if (e.target === e.currentTarget) clearSelection();
        }}
        onDragOver={(e) => {
          // Only respond to our own text-design drag — media-library file drops
          // have their own pipeline and must NOT be intercepted here.
          if (!e.dataTransfer.types.includes(SN_TEXT_DESIGN_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes(SN_TEXT_DESIGN_MIME)) return;
          e.preventDefault();
          void handleTextDesignDrop(e);
        }}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: native.w,
          height: native.h,
          transform: `scale(${renderScale})`,
          transformOrigin: 'top left',
          cursor: activeTool === 'hand' ? 'default' : 'default',
        }}
      >
        {/* Render visible clips, in track-order (bottom-up). `trackOrderById` is a
            precomputed Map so the comparator is O(1) instead of O(N) per call. */}
        {activeClips
          .slice()
          .sort((a, b) => {
            const ta = trackOrderById.get(a.track_id) ?? 0;
            const tb = trackOrderById.get(b.track_id) ?? 0;
            return ta - tb;
          })
          .map((c) => (
            <ClipLayer
              key={c.id}
              clip={c}
              assetsById={assetsById}
              videoRefs={videoRefs}
              transitionVisual={transitionState.byClip.get(c.id)}
              playheadMs={playhead}
              activeTool={activeTool}
            />
          ))}

        {/* Text overlays */}
        {activeClips
          .filter((c) => c.text_content)
          .map((c) => (
            <TextOverlay
              key={c.id}
              clip={c}
              playheadMs={playhead}
              activeTool={activeTool}
              transitionFadeMult={txnFadeMult}
            />
          ))}

        {/* Safe zones */}
        {showSafeZones && (
          <>
            <div style={{ position: 'absolute', inset: '8% 6%', border: '1px dashed rgba(255,255,255,0.18)', borderRadius: 4, pointerEvents: 'none' }} />
            {project.format === '9:16' && (
              <>
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '15%', background: 'rgba(0,0,0,0.04)', borderBottom: '1px dashed rgba(255,255,255,0.1)', pointerEvents: 'none' }} />
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '20%', background: 'rgba(0,0,0,0.04)', borderTop: '1px dashed rgba(255,255,255,0.1)', pointerEvents: 'none' }} />
              </>
            )}
          </>
        )}

        {/* Empty hint */}
        {activeClips.length === 0 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary)',
              fontSize: 13,
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <Icons.Upload size={20} stroke="var(--text-muted)" />
            <span className="display" style={{ fontSize: 18, color: 'var(--text-muted)' }}>
              Drop footage to start
            </span>
          </div>
        )}
      </div>
      </PreviewScaleContext.Provider>

        {/* Playback overlay. Compact icon buttons (18×18) so the row fits even on the narrow 9:16 canvas. */}
        {/* Lives at the CANVAS-WRAPPER level (NOT inside the scaled native div) so the
            controls always render at on-screen pixel sizes regardless of preview size. */}
        <div
          style={{
            position: 'absolute',
            left: 8,
            right: 8,
            bottom: 8,
            background: 'rgba(10,10,12,0.85)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 10,
            padding: '6px 8px',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            minWidth: 0,
          }}
        >
          <MiniBtn onClick={() => setPlayhead(0)} title="Start"><Icons.SkipBack size={11} /></MiniBtn>
          <MiniBtn onClick={() => setPlayhead(Math.max(0, playhead - 5000))} title="−5s"><Icons.Back5 size={11} /></MiniBtn>
          <button
            onClick={togglePlay}
            disabled={durationMs <= 0}
            style={{
              flex: '0 0 22px',
              width: 22,
              height: 22,
              marginInline: 2,
              borderRadius: '50%',
              background: 'var(--accent-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#0A0A0C',
              opacity: durationMs > 0 ? 1 : 0.4,
              cursor: durationMs > 0 ? 'pointer' : 'not-allowed',
            }}
            title={durationMs > 0 ? 'Play / Pause (Space)' : 'Add a clip to start'}
          >
            {isPlaying ? <Icons.Pause size={10} /> : <Icons.Play size={10} />}
          </button>
          <MiniBtn onClick={() => setPlayhead(Math.min(durationMs, playhead + 5000))} title="+5s"><Icons.Fwd5 size={11} /></MiniBtn>
          <MiniBtn onClick={() => setPlayhead(durationMs)} title="End"><Icons.SkipFwd size={11} /></MiniBtn>
          <div
            style={{
              flex: '1 1 0%',
              minWidth: 0,
              height: 3,
              marginInline: 4,
              background: 'rgba(255,255,255,0.1)',
              borderRadius: 3,
              position: 'relative',
              cursor: durationMs > 0 ? 'pointer' : 'default',
              opacity: durationMs > 0 ? 1 : 0.35,
            }}
            onPointerDown={(e) => {
              if (durationMs <= 0) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const p = (e.clientX - rect.left) / rect.width;
              setPlayhead(p * durationMs);
            }}
          >
            {durationMs > 0 && (
              <>
                <div
                  style={{
                    position: 'absolute',
                    inset: '0 auto 0 0',
                    width: `${Math.min(100, (playhead / durationMs) * 100)}%`,
                    background: 'var(--accent-primary)',
                    borderRadius: 3,
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    left: `${Math.min(100, (playhead / durationMs) * 100)}%`,
                    top: -3,
                    width: 9,
                    height: 9,
                    background: 'var(--accent-primary)',
                    borderRadius: '50%',
                    transform: 'translateX(-50%)',
                    boxShadow: '0 0 0 2px rgba(200,242,58,0.25)',
                  }}
                />
              </>
            )}
          </div>
          <span className="mono" style={{ fontSize: 9, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: '0 0 auto' }}>
            {formatTimePair(playhead, durationMs)}
          </span>
          <div style={{ position: 'relative', flex: '0 0 auto' }}>
            <MiniBtn
              onClick={(e) => {
                e?.stopPropagation();
                if (e?.shiftKey) togglePreviewMuted();
                else setVolumePopover((o) => !o);
              }}
              title={previewMuted ? 'Unmute (click), or Shift-click to toggle' : 'Volume (click), or Shift-click to mute'}
            >
              {previewMuted || previewVolume === 0 ? <Icons.Mute size={11} /> : <Icons.Volume size={11} />}
            </MiniBtn>
            {volumePopover && (
              <>
                {/* Click-outside backdrop — captures pointer events outside the popover. */}
                <div
                  onClick={() => setVolumePopover(false)}
                  onContextMenu={() => setVolumePopover(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 29, background: 'transparent' }}
                />
              <div
                onMouseLeave={() => setVolumePopover(false)}
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 8px)',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 120,
                  padding: '10px 12px',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 8,
                  boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                  zIndex: 30,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <button
                    onClick={togglePreviewMuted}
                    style={{ color: previewMuted ? 'var(--accent-primary)' : 'var(--text-secondary)' }}
                    title={previewMuted ? 'Unmute' : 'Mute'}
                  >
                    {previewMuted ? <Icons.Mute size={12} /> : <Icons.Volume size={12} />}
                  </button>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {Math.round((previewMuted ? 0 : previewVolume) * 100)}%
                  </span>
                </div>
                <Slider value={previewMuted ? 0 : previewVolume} min={0} max={1} onChange={setPreviewVolume} />
              </div>
              </>
            )}
          </div>
          <MiniBtn onClick={toggleFullscreen} title="Fullscreen (F)"><Icons.Full size={11} /></MiniBtn>
        </div>
      </div>

      {/* Top-left format readout */}
      <div style={{ position: 'absolute', top: 16, left: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="sn-pill">
          <span className="dot" style={{ background: 'var(--accent-primary)' }} />
          {project.format} · {project.width}×{project.height}
        </span>
        <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', paddingLeft: 4 }}>
          fit · {Math.round(((canvasBox.h * canvasRatio.w) / canvasRatio.h / project.width) * 100)}%
        </span>
        {activeTool === 'hand' && (
          <span
            className="sn-pill"
            style={{ background: 'rgba(200,242,58,0.08)', borderColor: 'rgba(200,242,58,0.4)', color: 'var(--accent-primary)' }}
          >
            <Icons.Hand size={10} stroke="var(--accent-primary)" /> Grab anything to move it
          </span>
        )}
      </div>

      {/* Top-right canvas tools */}
      <div style={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 4 }}>
        <button
          className={`sn-icon-btn ${showSafeZones ? 'active' : ''}`}
          onClick={toggleSafeZones}
          title="Toggle safe zones (G)"
        >
          <Icons.Grid size={13} />
        </button>
        <button className="sn-icon-btn" onClick={toggleFullscreen} title="Fullscreen preview (F)">
          <Icons.Full size={13} />
        </button>
      </div>
    </div>
  );
}

function parseGrade(json: string | null): Partial<ColorGrade> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Partial<ColorGrade>;
  } catch {
    return null;
  }
}

/**
 * Translate a `TransitionClipShape` into a CSS `clip-path` string the preview can apply
 * directly. The Studio compositor consumes the same shape via `ctx.clip()` and gets the
 * matching geometry — keeping wipe/iris visually identical between preview and export.
 */
function clipShapeToCss(shape: NonNullable<TransitionVisual['clipShape']>): string {
  if (shape.kind === 'inset') {
    return `inset(${shape.topPct}% ${shape.rightPct}% ${shape.bottomPct}% ${shape.leftPct}%)`;
  }
  return `circle(${shape.radiusPct}% at ${shape.cxPct}% ${shape.cyPct}%)`;
}

function ClipLayer({
  clip,
  assetsById,
  videoRefs,
  transitionVisual,
  playheadMs,
  activeTool,
}: {
  clip: Clip;
  assetsById: Map<string, import('@shared/types').MediaAsset>;
  videoRefs: React.MutableRefObject<Map<string, HTMLMediaElement>>;
  transitionVisual: TransitionVisual | undefined;
  playheadMs: number;
  activeTool: ReturnType<typeof useTimelineStore.getState>['activeTool'];
}): JSX.Element | null {
  const asset = clip.asset_id ? assetsById.get(clip.asset_id) : null;
  const scale = usePreviewScale();
  // Hand-tool drag state: while dragging we keep the new position in local React
  // state (not in the zustand store) so we don't trigger store-subscription
  // cascades on every pointermove. Only on pointerup do we commit to the store
  // and persist. Mirrors the pattern from ClipBlock.tsx:73-79.
  const dragRef = React.useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [localPos, setLocalPos] = React.useState<{ x: number; y: number } | null>(null);
  // Stable ref callback — using inline arrow makes React fire null-then-element
  // every render, which would tear down + rebuild the audio chain constantly
  // during playback. useCallback keeps identity stable so it only fires on real
  // mount/unmount.
  const mediaRef = React.useCallback(
    (el: HTMLMediaElement | null) => {
      if (el) {
        videoRefs.current.set(clip.id, el);
      } else {
        // Properly release the decoder + tear down the Web Audio chain bound to
        // the OLD element. Without this, repeated unmount/remount (e.g. clicking
        // back in the timeline to replay) leaks decoders and leaves stale
        // MediaElementAudioSourceNodes wired into the audio graph — that
        // accumulating cruft is what causes the progressive video stutter.
        const old = videoRefs.current.get(clip.id);
        videoRefs.current.delete(clip.id);
        teardownAudioFxForClip(clip.id);
        try {
          if (old) {
            old.pause();
            old.removeAttribute('src');
            old.load();
          }
        } catch {
          // ignore — element is going away anyway
        }
      }
    },
    [clip.id, videoRefs],
  );
  if (!asset) return null;
  const src = asset.proxy_path ? fileUrl(asset.proxy_path) : fileUrl(asset.original_path);
  const grade = parseGrade(clip.color_grade_json);
  const relativeMs = playheadMs - clip.start_time_ms;
  const kfTracks = parseKeyframesCached(clip.effects_json);
  const kf = valuesAt(kfTracks, relativeMs);
  // While dragging use the local override; otherwise fall back to keyframes / static values.
  const posX = localPos ? localPos.x : (kf.position_x ?? clip.position_x);
  const posY = localPos ? localPos.y : (kf.position_y ?? clip.position_y);
  const sclX = kf.scale_x ?? clip.scale_x;
  const sclY = kf.scale_y ?? clip.scale_y;
  const rot = kf.rotation ?? clip.rotation;
  const op = kf.opacity ?? clip.opacity;
  const motionFx = computeMotionFx(parseEffectsCached(clip.effects_json), relativeMs, clip.duration_ms);

  // Compose the clip's own transform with motion FX and the transition's extra transform.
  const ownTransform = `translate(${posX}px, ${posY}px) scale(${sclX}, ${sclY}) rotate(${rot}deg)`;
  const transform = [ownTransform, motionFx.transform, transitionVisual?.transform].filter(Boolean).join(' ');
  // Pre-mounted clips (rendered for decoder warm-up before they're actually visible)
  // must stay invisible until either their own time range OR an active transition
  // brings them in. Without this guard a 3s pre-mount would cover the currently-
  // playing clip with the next clip's first frame.
  const inOwnTimeRange = playheadMs >= clip.start_time_ms && playheadMs < clip.start_time_ms + clip.duration_ms;
  const isWarmupOnly = !inOwnTimeRange && !transitionVisual;
  const opacity = isWarmupOnly ? 0 : op * (transitionVisual?.opacity ?? 1);
  const gradeFilter = grade ? gradeToCSS(grade) : '';
  const transitionFilter = transitionVisual?.filter ?? '';
  const motionFxFilter = motionFx.filter ?? '';
  const filter = [gradeFilter, motionFxFilter, transitionFilter].filter(Boolean).join(' ') || undefined;
  const zIndex = transitionVisual?.zIndex;
  // Reveal-style transitions (wipe, iris) feed a clip mask through `clipShape`. We
  // convert it to a CSS `clip-path` string for the preview here; the Studio compositor
  // does the equivalent via `ctx.clip()`.
  const clipPath = transitionVisual?.clipShape
    ? clipShapeToCss(transitionVisual.clipShape)
    : undefined;

  const handGrab = activeTool === 'hand';
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!handGrab) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    useTimelineStore.getState().pushHistory();
    useTimelineStore.getState().selectClip(clip.id);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: clip.position_x,
      origY: clip.position_y,
    };
    setLocalPos({ x: clip.position_x, y: clip.position_y });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Convert screen pixels → native-canvas pixels so a 100-screen-px drag on a
    // half-scaled preview moves the clip by 200 native px (consistent regardless
    // of preview size).
    const s = scale || 1;
    const dx = (e.clientX - drag.startX) / s;
    const dy = (e.clientY - drag.startY) / s;
    setLocalPos({ x: drag.origX + dx, y: drag.origY + dy });
  };
  const onPointerUp = async (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const finalPos = localPos ?? { x: drag.origX, y: drag.origY };
    dragRef.current = null;
    setLocalPos(null);
    // Single commit on pointerup — first local store update for instant UI
    // feedback (no laggy snapback), then persist via IPC.
    useTimelineStore.getState().updateClipLocal(clip.id, {
      position_x: finalPos.x,
      position_y: finalPos.y,
    });
    try {
      const updated = await window.snipette.timeline.updateClip(clip.id, {
        position_x: finalPos.x,
        position_y: finalPos.y,
      });
      useTimelineStore.getState().replaceClip(updated);
    } catch {
      // best effort
    }
  };
  const onClickSelect = (e: React.MouseEvent) => {
    if (activeTool === 'select' || activeTool === 'hand') {
      e.stopPropagation();
      useTimelineStore.getState().selectClip(clip.id);
    }
  };
  const sharedHandStyle: React.CSSProperties = handGrab
    ? { pointerEvents: 'auto', cursor: dragRef.current ? 'grabbing' : 'grab' }
    : {};

  if (asset.type === 'image') {
    return (
      <img
        src={src}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onClickSelect}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity,
          transform,
          filter,
          zIndex,
          clipPath,
          ...sharedHandStyle,
        }}
        alt=""
      />
    );
  }
  if (asset.type === 'audio') {
    // Audio-only clips have no visual — but they still need an `<audio>` element in the
    // DOM so the preview's play/pause/seek effects (which operate on every entry in
    // `videoRefs`) drive playback. Without this, voice-overs and music clips are silent
    // during preview even though they appear on the timeline.
    // `preload="metadata"` (not `auto`) keeps Chromium from eagerly buffering full
    // audio data for every mounted clip — only what's needed for the window around
    // the playhead. The mount-window filter already restricts which clips have an
    // element at all.
    return (
      <audio
        ref={mediaRef}
        src={src}
        preload="metadata"
        style={{ display: 'none' }}
      />
    );
  }

  return (
    <video
      ref={mediaRef}
      src={src}
      muted={false}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onClickSelect}
      onLoadedMetadata={(e) => {
        const el = e.currentTarget;
        const playheadNow = useTimelineStore.getState().playheadMs;
        const offset = playheadNow - clip.start_time_ms;
        const sourceTimeS = (clip.source_in_ms + offset * clip.speed) / 1000;
        try {
          el.currentTime = Math.max(0, sourceTimeS);
        } catch {
          // ignore — bounds enforced by browser
        }
      }}
      onError={(e) => {
        const el = e.currentTarget;
        // eslint-disable-next-line no-console
        console.warn('[snipette] video load failed', { src: el.src, error: el.error });
      }}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        opacity,
        transform,
        filter,
        zIndex,
        clipPath,
        ...sharedHandStyle,
      }}
      preload="metadata"
      playsInline
    />
  );
}

function TextOverlay({
  clip,
  playheadMs,
  activeTool,
  transitionFadeMult,
}: {
  clip: Clip;
  playheadMs: number;
  activeTool: ReturnType<typeof useTimelineStore.getState>['activeTool'];
  transitionFadeMult: number;
}): JSX.Element {
  const scale = usePreviewScale();
  // Single parse per unique text_style_json — cached at module level so all the
  // text-style consumers (style application, font-size resize, etc.) hit the
  // same parsed object instead of JSON.parsing three times per render.
  const style = parseTextStyleCached(clip.text_style_json);

  const anim = parseTextAnimation(clip.text_animation_json);
  const relativeMs = playheadMs - clip.start_time_ms;
  const visual = computeTextAnimation(clip.text_content ?? '', relativeMs, clip.duration_ms, anim);
  // Hide pre-mounted text overlays (warmup-only). Without this, the BlockReveal
  // block — which is rendered at opacity 1 during the IN window — shows BEFORE
  // the clip's actual start_time_ms because the animation engine treats
  // relativeMs < 0 as "start of IN" (p=0). Same fix the ClipLayer uses.
  const inOwnTimeRange = playheadMs >= clip.start_time_ms && playheadMs < clip.start_time_ms + clip.duration_ms;
  // Opt-in: if the clip wants to fade with adjacent video transitions, multiply its
  // animation opacity by the V-shape transition multiplier.
  const rawOpacity = anim.fade_with_transition
    ? visual.opacity * transitionFadeMult
    : visual.opacity;
  const effectiveOpacity = inOwnTimeRange ? rawOpacity : 0;
  // In-place edit mode — double-click the overlay to edit text directly on the canvas.
  // While editing, suppress typewriter clipping + animation transforms so the user sees
  // their full text under their cursor.
  const [isEditing, setIsEditing] = React.useState(false);
  const editRef = React.useRef<HTMLSpanElement | null>(null);
  const text = isEditing
    ? clip.text_content ?? ''
    : visual.visibleText ?? clip.text_content ?? '';
  const isTypewriting = !isEditing && visual.visibleText !== undefined && relativeMs < anim.in_ms;
  const baseRotation = typeof style.rotation_deg === 'number' ? style.rotation_deg : 0;
  const selected = useTimelineStore((s) => s.selectedClipIds.includes(clip.id));

  // When entering edit mode, fill the contentEditable span with the current text once
  // and place the caret at the end. After that React leaves the children alone so the
  // user's keystrokes don't get clobbered by re-renders on every playhead tick.
  React.useEffect(() => {
    if (!isEditing || !editRef.current) return;
    editRef.current.textContent = clip.text_content ?? '';
    editRef.current.focus();
    const range = document.createRange();
    range.selectNodeContents(editRef.current);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  const commitEdit = React.useCallback(async () => {
    const el = editRef.current;
    if (!el) {
      setIsEditing(false);
      return;
    }
    const next = (el.innerText ?? '').replace(/ /g, ' '); // strip stray nbsp
    setIsEditing(false);
    if (next === (clip.text_content ?? '')) return;
    useTimelineStore.getState().pushHistory();
    try {
      const updated = await window.snipette.timeline.updateClip(clip.id, {
        text_content: next,
      });
      useTimelineStore.getState().replaceClip(updated);
    } catch {
      // best effort
    }
  }, [clip.id, clip.text_content]);

  const cancelEdit = React.useCallback(() => {
    if (editRef.current) editRef.current.textContent = clip.text_content ?? '';
    setIsEditing(false);
  }, [clip.text_content]);

  // Keyframes can drive position + scale too. Fall back to the static clip values.
  const tracks = parseKeyframesCached(clip.effects_json);
  const kfPx = valueAt(tracks, 'position_x', relativeMs) ?? clip.position_x;
  const kfPy = valueAt(tracks, 'position_y', relativeMs) ?? clip.position_y;
  const kfSclX = valueAt(tracks, 'scale_x', relativeMs) ?? clip.scale_x ?? 1;
  const kfSclY = valueAt(tracks, 'scale_y', relativeMs) ?? clip.scale_y ?? 1;

  // Local drag/resize state — same pattern as ClipBlock. While the user is
  // dragging or resizing, we keep the in-flight values in component state and
  // apply them via inline style. The zustand store is only touched on pointerup,
  // so a 120 Hz trackpad drag doesn't trigger 120 store-subscription cascades.
  const dragRef = React.useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [localPos, setLocalPos] = React.useState<{ x: number; y: number } | null>(null);
  const resizeRef = React.useRef<{
    centerX: number;
    centerY: number;
    startDist: number;
    origScaleX: number;
    origScaleY: number;
    origFontSize: number;
    origStyle: Record<string, unknown>;
  } | null>(null);
  const [localFontSize, setLocalFontSize] = React.useState<number | null>(null);
  const overlayRef = React.useRef<HTMLDivElement | null>(null);

  // Side-handle (left/right) state — widens the text BOX without touching font
  // size. Stored on text_style_json as `box_width_px`. Drag math mirrors the
  // corner-resize: capture origin width + start client X, apply screen-px delta
  // converted to native-px via canvas scale.
  const boxResizeRef = React.useRef<{
    startX: number;
    origWidth: number;
    side: 'left' | 'right';
    origStyle: Record<string, unknown>;
  } | null>(null);
  const [localBoxWidth, setLocalBoxWidth] = React.useState<number | null>(null);

  // While resizing, render with the in-flight font_size via a clone of the style.
  // This avoids round-tripping through the zustand store on every pointermove.
  const displayStyle = localFontSize !== null || localBoxWidth !== null
    ? {
        ...style,
        ...(localFontSize !== null ? { font_size: localFontSize } : {}),
        ...(localBoxWidth !== null ? { box_width_px: localBoxWidth } : {}),
      }
    : style;

  const px = localPos ? localPos.x : kfPx;
  const py = localPos ? localPos.y : kfPy;
  const sclX = kfSclX;
  const sclY = kfSclY;

  const startResize = (e: React.PointerEvent<HTMLElement>) => {
    e.stopPropagation();
    if (!overlayRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    useTimelineStore.getState().pushHistory();
    useTimelineStore.getState().selectClip(clip.id);
    const rect = overlayRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = e.clientX - centerX;
    const dy = e.clientY - centerY;
    // Snapshot the current font_size so we can scale it by the drag-distance ratio.
    // Drag-bigger == bigger font is the intuitive mental model (matches Figma/Keynote);
    // tracking it on font_size (instead of scale_x/scale_y) means the value the user
    // sees in the Text Inspector's font-size slider actually changes as they drag.
    let baseFontSize = 64;
    const origStyle = parseTextStyleCached(clip.text_style_json);
    if (typeof origStyle.font_size === 'number' && origStyle.font_size > 0) {
      baseFontSize = origStyle.font_size;
    }
    resizeRef.current = {
      centerX,
      centerY,
      startDist: Math.max(1, Math.sqrt(dx * dx + dy * dy)),
      origScaleX: clip.scale_x ?? 1,
      origScaleY: clip.scale_y ?? 1,
      origFontSize: baseFontSize,
      origStyle,
    };
    setLocalFontSize(baseFontSize);
  };

  const moveResize = (e: React.PointerEvent<HTMLElement>) => {
    const r = resizeRef.current;
    if (!r) return;
    const dx = e.clientX - r.centerX;
    const dy = e.clientY - r.centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const factor = dist / r.startDist;
    const nextFont = Math.max(8, Math.min(800, Math.round(r.origFontSize * factor)));
    setLocalFontSize(nextFont);
  };

  const endResize = async (e: React.PointerEvent<HTMLElement>) => {
    const r = resizeRef.current;
    if (!r) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const finalFont = localFontSize ?? r.origFontSize;
    resizeRef.current = null;
    setLocalFontSize(null);
    const nextStyle: Record<string, unknown> = { ...r.origStyle, font_size: finalFont };
    const nextJson = JSON.stringify(nextStyle);
    useTimelineStore.getState().updateClipLocal(clip.id, {
      text_style_json: nextJson,
    });
    try {
      const updated = await window.snipette.timeline.updateClip(clip.id, {
        text_style_json: nextJson,
      });
      useTimelineStore.getState().replaceClip(updated);
    } catch {
      // best effort
    }
  };

  // Side-handle resize: widens / narrows the text BOX only. Font size unchanged
  // so the user can control wrap width independently from text size.
  const startBoxResize = (side: 'left' | 'right') => (e: React.PointerEvent<HTMLElement>) => {
    e.stopPropagation();
    if (!overlayRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    useTimelineStore.getState().pushHistory();
    useTimelineStore.getState().selectClip(clip.id);
    const origStyle = parseTextStyleCached(clip.text_style_json);
    const rect = overlayRef.current.getBoundingClientRect();
    // Measure the current rendered width in native px so dragging from any
    // starting width works smoothly. CSS box-sizing is content-box but the
    // wrapper is inline-block — `rect.width` is the visual width on screen,
    // we divide by the canvas scale to get native px.
    const s = scale || 1;
    const currentWidthNative =
      typeof origStyle.box_width_px === 'number'
        ? (origStyle.box_width_px as number)
        : Math.round(rect.width / s);
    boxResizeRef.current = {
      startX: e.clientX,
      origWidth: currentWidthNative,
      side,
      origStyle,
    };
    setLocalBoxWidth(currentWidthNative);
  };

  const moveBoxResize = (e: React.PointerEvent<HTMLElement>) => {
    const r = boxResizeRef.current;
    if (!r) return;
    const s = scale || 1;
    // Left handle drags inward = narrower; right handle drags outward = wider.
    // Multiply by 2 because the text box is centered — widening only one side
    // visually would feel half as effective. Mirrors how design tools handle
    // centered objects.
    const dxNative = ((e.clientX - r.startX) / s) * 2;
    const delta = r.side === 'left' ? -dxNative : dxNative;
    const next = Math.max(40, Math.min(8000, Math.round(r.origWidth + delta)));
    setLocalBoxWidth(next);
  };

  const endBoxResize = async (e: React.PointerEvent<HTMLElement>) => {
    const r = boxResizeRef.current;
    if (!r) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const finalWidth = localBoxWidth ?? r.origWidth;
    boxResizeRef.current = null;
    setLocalBoxWidth(null);
    const nextStyle: Record<string, unknown> = { ...r.origStyle, box_width_px: finalWidth };
    const nextJson = JSON.stringify(nextStyle);
    useTimelineStore.getState().updateClipLocal(clip.id, { text_style_json: nextJson });
    try {
      const updated = await window.snipette.timeline.updateClip(clip.id, {
        text_style_json: nextJson,
      });
      useTimelineStore.getState().replaceClip(updated);
    } catch {
      // best effort
    }
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Text overlays are always grabbable EXCEPT under tools that own the click
    // (Razor splits, Zoom changes scale). Avoids the V↔H tool-toggle dance just to
    // move a text bubble around.
    if (activeTool === 'razor' || activeTool === 'zoom') return;
    // Ignore right/middle clicks so context menus + middle-pan still work.
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    useTimelineStore.getState().pushHistory();
    useTimelineStore.getState().selectClip(clip.id);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: clip.position_x,
      origY: clip.position_y,
    };
    setLocalPos({ x: clip.position_x, y: clip.position_y });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Screen-pixels → native-pixels so drag distance feels right regardless of
    // how the preview is sized on screen.
    const s = scale || 1;
    const dx = (e.clientX - drag.startX) / s;
    const dy = (e.clientY - drag.startY) / s;
    setLocalPos({ x: drag.origX + dx, y: drag.origY + dy });
  };
  const onPointerUp = async (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const finalPos = localPos ?? { x: drag.origX, y: drag.origY };
    dragRef.current = null;
    setLocalPos(null);
    useTimelineStore.getState().updateClipLocal(clip.id, {
      position_x: finalPos.x,
      position_y: finalPos.y,
    });
    try {
      const updated = await window.snipette.timeline.updateClip(clip.id, {
        position_x: finalPos.x,
        position_y: finalPos.y,
      });
      useTimelineStore.getState().replaceClip(updated);
    } catch {
      // best effort
    }
  };

  // Whether text-overlay clicks should be captured by the overlay itself. Razor and
  // Zoom tools own clicks on the canvas, so they pass through; every other tool means
  // the overlay is grabbable + selectable + editable.
  const interactive = activeTool !== 'razor' && activeTool !== 'zoom';

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    useTimelineStore.getState().selectClip(clip.id);
    const setContextMenu = useEditorStore.getState().setContextMenu;
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { kind: 'header', label: `Text · ${(clip.text_content ?? '').slice(0, 40) || 'Untitled'}` },
        {
          label: 'Edit text',
          onClick: () => setIsEditing(true),
        },
        {
          label: 'Reset transform',
          onClick: async () => {
            useTimelineStore.getState().pushHistory();
            const reset = { position_x: 0, position_y: 0, scale_x: 1, scale_y: 1, rotation: 0 };
            useTimelineStore.getState().updateClipLocal(clip.id, reset);
            try {
              const updated = await window.snipette.timeline.updateClip(clip.id, reset);
              useTimelineStore.getState().replaceClip(updated);
            } catch {
              // local already updated; non-fatal
            }
          },
        },
        {
          // TODO: enable once a duplicateClip store action / IPC handler lands. Right now
          // there's no first-class duplicate path, so we mark this disabled rather than
          // inventing one.
          label: 'Duplicate',
          hint: '⌘D',
          disabled: true,
          onClick: () => {
            // No-op — see TODO above.
          },
        },
        { kind: 'separator' },
        {
          label: 'Delete',
          hint: 'Backspace',
          danger: true,
          onClick: async () => {
            useTimelineStore.getState().pushHistory();
            useTimelineStore.getState().removeClip(clip.id);
            try {
              await window.snipette.timeline.deleteClip(clip.id);
            } catch {
              // local already updated; non-fatal
            }
          },
        },
      ],
    });
  };

  return (
    <div
      ref={overlayRef}
      onPointerDown={isEditing ? (e) => e.stopPropagation() : onPointerDown}
      onPointerMove={isEditing ? undefined : onPointerMove}
      onPointerUp={isEditing ? undefined : onPointerUp}
      onContextMenu={onContextMenu}
      onClick={(e) => {
        if (isEditing) {
          e.stopPropagation();
          return;
        }
        if (interactive) {
          e.stopPropagation();
          useTimelineStore.getState().selectClip(clip.id);
        }
      }}
      onDoubleClick={(e) => {
        // Double-click anywhere on the overlay enters in-place edit mode (CapCut-style).
        e.stopPropagation();
        useTimelineStore.getState().selectClip(clip.id);
        setIsEditing(true);
      }}
      style={{
        position: 'absolute',
        left: '50%',
        bottom: '12%',
        opacity: effectiveOpacity,
        // Compose: center the box, apply static + animated position offsets, rotate, then run animation transform.
        transform: isEditing
          ? `translate(-50%, 0) translate(${px}px, ${py}px) rotate(${baseRotation}deg) scale(${sclX}, ${sclY})`
          : `translate(-50%, 0) translate(${px}px, ${py}px) rotate(${baseRotation}deg) scale(${sclX}, ${sclY}) ${visual.transform}`,
        filter: isEditing ? undefined : visual.filter,
        pointerEvents: isEditing || interactive ? 'auto' : 'none',
        cursor: isEditing
          ? 'text'
          : interactive
            ? dragRef.current
              ? 'grabbing'
              : 'move'
            : 'default',
        // Box width — if the user has explicitly widened via the side handles,
        // honor that pixel value. Otherwise grow naturally with content, capped
        // at 95% of the canvas. Corner-resize stays font-size-only, so this is
        // the only way to control wrap width independently.
        ...(typeof (displayStyle as { box_width_px?: number }).box_width_px === 'number'
          ? { width: `${(displayStyle as { box_width_px: number }).box_width_px}px`, maxWidth: '95%' }
          : { maxWidth: '95%', width: 'max-content' }),
        textAlign: (style.align as 'center') ?? 'center',
        outline: isEditing
          ? '1.5px dashed var(--accent-primary)'
          : selected && interactive
            ? '1.5px solid var(--accent-primary)'
            : 'none',
        outlineOffset: 4,
      }}
    >
      {isEditing ? (
        // Distinct `key` is load-bearing: it forces React to unmount this span when
        // isEditing flips false. Without it React reuses the same DOM <span> and the
        // user-typed text nodes (added by the browser, outside React's diffing) stick
        // around in parallel with the new JSX children — visible as duplicated text.
        <span
          key="textoverlay-editing"
          ref={editRef}
          contentEditable
          suppressContentEditableWarning
          spellCheck={true}
          onBlur={() => void commitEdit()}
          onKeyDown={(e) => {
            // Don't let timeline shortcuts (space/play, etc.) fire while typing.
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              cancelEdit();
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void commitEdit();
            }
          }}
          style={{
            ...textStyleToCss(displayStyle as Parameters<typeof textStyleToCss>[0]),
            outline: 'none',
            cursor: 'text',
            minWidth: '4ch',
            whiteSpace: 'pre-wrap',
          }}
        />
      ) : anim.loop_preset === 'Karaoke' && anim.word_timings && anim.word_timings.length > 0 ? (
        <KaraokeText
          key="textoverlay-karaoke"
          style={displayStyle as Parameters<typeof textStyleToCss>[0]}
          wordTimings={anim.word_timings}
          mode={anim.karaoke_mode ?? 'highlight'}
          relativeMs={relativeMs}
        />
      ) : visual.blockRevealProgress !== undefined ||
        anim.subtitle_text !== undefined ||
        anim.in_preset === 'BlockReveal' ? (
        <BlockRevealText
          key="textoverlay-blockreveal"
          style={displayStyle as Parameters<typeof textStyleToCss>[0]}
          text={text}
          role={anim.compound_role ?? 'title'}
          blockColor={anim.block_color ?? '#C8F23A'}
          // When `undefined`, the IN window has finished — BlockRevealText
          // renders the resting state (both rows visible, NO block). Falling
          // back to 0 here would re-show the block; falling back to 1 settles
          // both rows correctly.
          progress={visual.blockRevealProgress}
          subtitleText={anim.subtitle_text}
          subtitleStyleJson={anim.subtitle_style_json}
        />
      ) : visual.letterWaveProgress !== undefined ? (
        <LetterWaveText
          key="textoverlay-letterwave"
          style={displayStyle as Parameters<typeof textStyleToCss>[0]}
          text={text}
          progress={visual.letterWaveProgress}
        />
      ) : (
        <span
          key="textoverlay-display"
          style={textStyleToCss(displayStyle as Parameters<typeof textStyleToCss>[0])}
        >
          {text}
          {/* Typewriter caret. Shown while typing (legacy behaviour) OR while the
              user has explicitly enabled `typewriter_cursor` and we're inside the
              ~600ms tail after typing completes. */}
          {isTypewriting && text.length < (clip.text_content ?? '').length && (
            <span className="sn-caret" style={{ marginLeft: 2, color: 'var(--accent-primary)' }}>
              |
            </span>
          )}
          {anim.typewriter_cursor &&
            anim.in_preset === 'Typewriter' &&
            !isTypewriting &&
            (() => {
              // 600ms persistent caret after typing finishes, then fades over 300ms.
              const fullText = clip.text_content ?? '';
              const cps = anim.typewriter_cps > 0 ? anim.typewriter_cps : 14;
              const typeEndMs = (fullText.length / cps) * 1000;
              const tail = relativeMs - typeEndMs;
              if (tail < 0 || tail > 900) return null;
              const opacity = tail < 600 ? 1 : 1 - (tail - 600) / 300;
              return (
                <span
                  className="sn-caret"
                  style={{ marginLeft: 2, color: 'var(--accent-primary)', opacity }}
                >
                  |
                </span>
              );
            })()}
        </span>
      )}
      {selected && !isEditing && (
        <>
          {/* Selection outline. Drawn at the wrapper's natural box so it traces the
              text — including its scale transform. */}
          <div
            style={{
              position: 'absolute',
              inset: -4,
              border: '1.5px dashed var(--accent-primary)',
              borderRadius: 4,
              pointerEvents: 'none',
            }}
          />
          {/* Four corner handles. Inverse-scaled so they stay roughly 12 px regardless of
              how big the text was scaled — otherwise a 2× text would also double the
              handle size, and 0.5× text would shrink them past grabbability. */}
          {(
            [
              { id: 'tl', top: -6, left: -6, cursor: 'nwse-resize' },
              { id: 'tr', top: -6, right: -6, cursor: 'nesw-resize' },
              { id: 'bl', bottom: -6, left: -6, cursor: 'nesw-resize' },
              { id: 'br', bottom: -6, right: -6, cursor: 'nwse-resize' },
            ] as const
          ).map((h) => (
            <div
              key={h.id}
              onPointerDown={startResize}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              style={{
                position: 'absolute',
                width: 12,
                height: 12,
                top: 'top' in h ? h.top : undefined,
                bottom: 'bottom' in h ? h.bottom : undefined,
                left: 'left' in h ? h.left : undefined,
                right: 'right' in h ? h.right : undefined,
                background: 'var(--accent-primary)',
                border: '1.5px solid #0A0A0C',
                borderRadius: 2,
                cursor: h.cursor,
                transform: `scale(${1 / Math.max(0.1, sclX * scale)}, ${1 / Math.max(0.1, sclY * scale)})`,
                transformOrigin: '50% 50%',
                pointerEvents: 'auto',
                zIndex: 5,
              }}
            />
          ))}
          {/* Two side handles — widen / narrow the BOX without changing font size.
              Independent control means corner-drag = scale text+box together,
              side-drag = scale only the wrap width. */}
          {(
            [
              { id: 'ml', side: 'left' as const, top: '50%', left: -6 },
              { id: 'mr', side: 'right' as const, top: '50%', right: -6 },
            ]
          ).map((h) => (
            <div
              key={h.id}
              onPointerDown={startBoxResize(h.side)}
              onPointerMove={moveBoxResize}
              onPointerUp={endBoxResize}
              style={{
                position: 'absolute',
                width: 8,
                height: 18,
                top: h.top,
                left: 'left' in h ? h.left : undefined,
                right: 'right' in h ? h.right : undefined,
                marginTop: -9, // half of height to center on 50%
                background: 'var(--accent-primary)',
                border: '1.5px solid #0A0A0C',
                borderRadius: 2,
                cursor: 'ew-resize',
                transform: `scale(${1 / Math.max(0.1, sclX * scale)}, ${1 / Math.max(0.1, sclY * scale)})`,
                transformOrigin: '50% 50%',
                pointerEvents: 'auto',
                zIndex: 5,
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * Word-by-word karaoke caption renderer. Each word is its own span so we can drive
 * colour, opacity, and a small scale-pop based on the current word's timing. Smooth
 * transitions are CSS-driven so the highlight slides gracefully even when the
 * preview is running at a low frame rate (the playhead update interval is ~30fps).
 */
function KaraokeText({
  style,
  wordTimings,
  mode,
  relativeMs,
}: {
  style: Parameters<typeof textStyleToCss>[0];
  wordTimings: { word: string; startMs: number; endMs: number }[];
  mode: 'highlight' | 'reveal' | 'bounce' | 'glow' | 'pop-each';
  relativeMs: number;
}): JSX.Element {
  const states = computeKaraokeWordStates(wordTimings, relativeMs, mode);
  const baseCss = textStyleToCss(style);
  // The base style was designed for a single block. For per-word we strip the
  // padding/background (they'd repeat per word) and instead let the wrapper own them.
  const wrapperCss: React.CSSProperties = {
    ...baseCss,
    padding: 0,
    background: 'transparent',
  };
  // Accent colour pulled from CSS variable so it follows the theme.
  const accent = 'var(--accent-primary)';
  const baseColor = (baseCss.color as string) ?? '#fff';

  return (
    <span style={wrapperCss}>
      {states.map((s, i) => {
        const t = wordTimings[i];
        // Per-word progress (0..1 across the word's spoken duration). Used by
        // `bounce` and `pop-each` modes to drive scale curves and by `glow` to
        // pulse the active text-shadow.
        const wordDur = Math.max(1, t.endMs - t.startMs);
        const wordP = Math.min(1, Math.max(0, (relativeMs - t.startMs) / wordDur));

        // --- transform & opacity ---
        let transform = 'scale(1)';
        let opacity: number;
        let color = s.active ? accent : baseColor;
        let textShadow: string | undefined;

        if (mode === 'bounce') {
          // All words visible. Active word scales 1.0 → 1.15 → 1.0 over its window.
          // Past + future inactive words sit at 1.0.
          opacity = !s.visible ? 0 : s.active ? 1 : 0.9;
          if (s.active) {
            const bump = Math.sin(wordP * Math.PI) * 0.15; // peak at midpoint
            transform = `scale(${1 + bump})`;
          }
        } else if (mode === 'glow') {
          // Active word gets a pulsing text-shadow glow. Color stays the base
          // colour (glow does the emphasis) unless caller styled it otherwise.
          opacity = !s.visible ? 0 : s.active ? 1 : s.past ? 0.9 : 0.65;
          if (s.active) {
            const pulse = 0.5 + Math.sin(wordP * Math.PI) * 0.5;
            const size = 8 + pulse * 18;
            textShadow = `0 0 ${size}px ${accent}, 0 0 ${size * 2}px ${accent}`;
            color = baseColor;
          }
        } else if (mode === 'pop-each') {
          // Each word pops in as it activates: scale 0.4 → 1.15 → 1.0 with easeOutBack.
          // Once past, the word sits at 1.0 / full opacity.
          if (s.past) {
            opacity = 1;
            transform = 'scale(1)';
            color = baseColor;
          } else if (s.active) {
            // easeOutBack curve, then ease back to 1.
            const c = 1.70158;
            const c3 = c + 1;
            const eased = 1 + c3 * Math.pow(wordP - 1, 3) + c * Math.pow(wordP - 1, 2);
            const scale = 0.4 + eased * 0.6 + (1 - eased) * 0; // 0.4..1.0 via easeOutBack
            // Tack on a tiny overshoot peak at wordP≈0.6 → 1.15.
            const overshoot = wordP < 0.7 ? Math.sin(wordP * Math.PI / 0.7) * 0.15 : 0;
            opacity = Math.min(1, wordP * 3);
            transform = `scale(${scale + overshoot})`;
          } else {
            opacity = 0;
          }
        } else if (mode === 'reveal') {
          opacity = !s.visible ? 0 : s.active ? 1 : 1;
          transform = s.active ? 'scale(1.08)' : 'scale(1)';
        } else {
          // highlight (default)
          opacity = !s.visible ? 0 : s.active ? 1 : s.past ? 1 : 0.55;
          transform = s.active ? 'scale(1.08)' : 'scale(1)';
        }

        const wordStyle: React.CSSProperties = {
          display: 'inline-block',
          transition: 'opacity 80ms linear, color 80ms linear, transform 120ms ease-out, text-shadow 80ms linear',
          color,
          opacity,
          transform,
          textShadow,
          // Preserve any text fill/clip from rainbow/gradient on the wrapper.
          WebkitTextFillColor: s.active && (mode === 'highlight' || mode === 'reveal') ? accent : undefined,
        };
        return (
          <span key={i} style={wordStyle}>
            {s.word}
            {i < states.length - 1 ? ' ' : ''}
          </span>
        );
      })}
    </span>
  );
}

/**
 * Per-letter wave-in renderer. Splits `text` into a span per grapheme, each
 * staggered by ~30ms / letter (in normalized progress units) so the letters
 * pop up in sequence — a Mexican wave across the word. Only active during the
 * IN phase; once the wave completes the renderer is replaced by the plain
 * display branch (so editing still works).
 */
function LetterWaveText({
  style,
  text,
  progress,
}: {
  style: Parameters<typeof textStyleToCss>[0];
  text: string;
  progress: number;
}): JSX.Element {
  const baseCss = textStyleToCss(style);
  const wrapperCss: React.CSSProperties = {
    ...baseCss,
    padding: baseCss.padding,
    // Wrapper still owns the bg pill / padding so the bar appears as a unit.
  };
  // Use Intl.Segmenter when available for proper grapheme split (handles
  // emoji + composed chars); fall back to Array.from which still splits on
  // code points reasonably.
  const letters: string[] = (() => {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(seg.segment(text), (s) => s.segment);
    }
    return Array.from(text);
  })();
  // Stagger budget: each letter spans 1/N of the progress with overlap so letters
  // can finish their personal animation by the time progress reaches 1.
  const n = Math.max(1, letters.length);
  const perLetter = 1 / Math.max(4, n); // overlap roughly so total runs in 1.0
  return (
    <span style={wrapperCss}>
      {letters.map((ch, i) => {
        // Each letter's local 0..1 based on global progress.
        const start = (i / n) * 0.6; // last letter starts at 0.6 of progress
        const localP = Math.min(1, Math.max(0, (progress - start) / Math.max(0.001, perLetter)));
        const y = (1 - localP) * 40;
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              opacity: localP,
              transform: `translateY(${y}px)`,
              willChange: 'transform, opacity',
              whiteSpace: ch === ' ' ? 'pre' : undefined,
            }}
          >
            {ch}
          </span>
        );
      })}
    </span>
  );
}

/**
 * BlockReveal renderer — paints a stacked title + subtitle pair as one
 * compound text overlay. Used by the single-clip BlockReveal compound
 * template; renders both rows so the user can click once on the clip to edit
 * both, and the block background that the title slides out of disappears
 * cleanly after the IN window finishes.
 *
 * Animation phases (the IN window splits its `progress` 0..1 into two stages):
 *   - 0.00..0.70 → title block + clip-path reveal slide.
 *   - 0.70..1.00 → subtitle drops in from above into its resting position.
 *
 * Resting state (`progress === undefined`, i.e. past the IN window):
 *   - title is fully visible, NO block (block never lingers).
 *   - subtitle is fully visible at its resting position.
 *
 * A non-compound BlockReveal clip (no `subtitleText`) only renders the title
 * row — back-compat for the legacy two-clip flow's stray clips.
 */
function BlockRevealText({
  style,
  text,
  role,
  blockColor,
  progress,
  subtitleText,
  subtitleStyleJson,
}: {
  style: Parameters<typeof textStyleToCss>[0];
  text: string;
  role: 'title' | 'subtitle';
  blockColor: string;
  /** Undefined when the IN window has ended — render both rows in resting state. */
  progress: number | undefined;
  /** When set, render a subtitle row beneath the title (compound mode). */
  subtitleText?: string;
  /** Optional independent style for the subtitle row; falls back to the title style. */
  subtitleStyleJson?: string;
}): JSX.Element {
  const baseCss = textStyleToCss(style);
  // Resolve the subtitle's style — JSON-decode the per-row style if present,
  // otherwise inherit from the title for a sensible default.
  const subStyleObj: Parameters<typeof textStyleToCss>[0] = (() => {
    if (!subtitleStyleJson) return style;
    try {
      return JSON.parse(subtitleStyleJson) as Parameters<typeof textStyleToCss>[0];
    } catch {
      return style;
    }
  })();
  const subBaseCss = textStyleToCss(subStyleObj);

  const hasSubtitle = subtitleText !== undefined;
  // Single source of truth for the IN progress. When undefined we're past the
  // IN window → settled state for everything (title at rest, no block,
  // subtitle at rest).
  const settled = progress === undefined;
  const p = settled ? 1 : progress;

  // Split the IN window into title-phase (0..0.7) and subtitle-phase (0.7..1).
  // When NOT a compound clip the whole window drives the title (no split).
  const titleP = hasSubtitle ? Math.min(1, p / 0.7) : p;
  const subP = hasSubtitle ? Math.max(0, Math.min(1, (p - 0.7) / 0.3)) : 1;

  // Title block + reveal -----------------------------------------------
  // Phase 1 (0..0.22): block sits, text invisible behind it.
  // Phase 2 (0.22..0.85): block stays, text reveals left → right.
  // Phase 3 (0.85..1):   block fades to 0.
  // When `settled`, force the block fully gone so it can NEVER linger past
  // the IN window even if the title-phase math is touched in the future.
  const blockOpacity = settled
    ? 0
    : titleP < 0.85
      ? 1
      : 1 - (titleP - 0.85) / 0.15;
  const revealP = Math.min(1, Math.max(0, (titleP - 0.22) / 0.63));
  const easedTitle = 1 - Math.pow(1 - revealP, 3);
  const inset = (1 - easedTitle) * 100; // right inset %, 100 → 0
  const tx = (1 - easedTitle) * -28; // text starts a bit to the left of final position

  const titleRow = (
    <span
      style={{
        // Container is relative so the block can be absolutely positioned
        // behind the text without affecting the text's flow.
        position: 'relative',
        display: 'inline-block',
        padding: 0,
        background: 'transparent',
      }}
    >
      {blockOpacity > 0.001 && (() => {
        // Entry pop: in the first 12% of the title-phase the block scales in
        // horizontally from 0 → 1, easeOutBack-style, so it visibly "shoots in"
        // before the text reveals out of it. Previously the block appeared
        // already-full at frame 0 which read as "no animation."
        const entryP = Math.min(1, titleP / 0.12);
        const eased = entryP * entryP * (2.7 * entryP - 1.7);
        const scaleX = settled ? 1 : Math.max(0, eased);
        return (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              // Slightly inflate the block beyond the text bounds for a meatier "block".
              inset: -6,
              background: blockColor,
              opacity: blockOpacity,
              borderRadius: 4,
              zIndex: 0,
              transform: `scaleX(${scaleX.toFixed(3)})`,
              transformOrigin: 'left center',
            }}
          />
        );
      })()}
      <span
        style={{
          ...baseCss,
          position: 'relative',
          zIndex: 1,
          display: 'inline-block',
          // Mask: hide everything to the right of `inset`% so the text reveals
          // left → right, as if it was extruded out of the block. When settled
          // we drop the clip-path entirely so the text isn't clipped at all.
          ...(settled
            ? {}
            : {
                clipPath: `inset(0 ${inset.toFixed(2)}% 0 0)`,
                WebkitClipPath: `inset(0 ${inset.toFixed(2)}% 0 0)`,
              }),
          transform: settled ? 'none' : `translateX(${tx.toFixed(2)}px)`,
        }}
      >
        {text}
      </span>
    </span>
  );

  // Subtitle row -------------------------------------------------------
  // Drops in from above (translateY -110% → 0) inside an overflow-hidden
  // wrapper so it visually emerges from the title above.
  const easedSub = 1 - Math.pow(1 - subP, 3);
  const ty = -110 + easedSub * 110;
  const subRow = hasSubtitle ? (
    <span
      style={{
        display: 'inline-block',
        // overflow-hidden only matters during the drop; once settled it's
        // harmless either way.
        overflow: 'hidden',
        padding: 0,
        marginTop: 6,
      }}
    >
      <span
        style={{
          ...subBaseCss,
          display: 'inline-block',
          transform: settled ? 'none' : `translateY(${ty.toFixed(2)}%)`,
          opacity: settled ? 1 : Math.min(1, subP * 1.8),
        }}
      >
        {subtitleText}
      </span>
    </span>
  ) : null;

  // Legacy two-clip path: a standalone subtitle clip (role='subtitle' with
  // NO compound subtitle_text on this clip) still renders its drop-in for
  // back-compat with old project files.
  if (role === 'subtitle' && !hasSubtitle) {
    return (
      <span
        style={{
          display: 'inline-block',
          overflow: 'hidden',
          padding: 0,
        }}
      >
        <span
          style={{
            ...baseCss,
            display: 'inline-block',
            transform: settled ? 'none' : `translateY(${ty.toFixed(2)}%)`,
            opacity: settled ? 1 : Math.min(1, p * 1.8),
          }}
        >
          {text}
        </span>
      </span>
    );
  }

  // Compound (or plain title-only) BlockReveal: stack title + subtitle.
  return (
    <span
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0,
      }}
    >
      {titleRow}
      {subRow}
    </span>
  );
}

function MiniBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        flex: '0 0 18px',
        width: 18,
        height: 18,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-secondary)',
        borderRadius: 4,
        transition: 'color .12s, background .12s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = 'var(--text-primary)';
        e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = 'var(--text-secondary)';
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}
