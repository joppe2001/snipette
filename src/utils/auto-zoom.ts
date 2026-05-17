/**
 * Auto Punch-In Zoom — derive subtle scale-keyframe curves on video clips that
 * visually overlap voice activity in a voice clip. The idea is the same as a
 * vlog editor's "punch in when the speaker talks" move: scale to 1.08× while
 * the speaker is talking, scale back to 1.0× during pauses, with short ramps
 * either side so the move feels organic rather than snapping.
 *
 * This module is PURE: no IPC, no store mutations, no React. It takes a voice
 * clip + its waveform + every clip on the timeline and returns the per-clip
 * keyframe updates that the caller should write via `writeKeyframes` +
 * `updateClip`. Keeping it pure means the panel UI stays thin and the math
 * is unit-testable in isolation.
 */

import type { Clip } from '@shared/types';
import { detectVoiceActivity, type DuckSegment } from './audio-analysis';
import type { Keyframe, KeyframeEasing } from './keyframes';

/** Default peak zoom factor. Subtle by design — 8% is the documentary-vlog norm. */
const DEFAULT_ZOOM_FACTOR = 1.08;
/** Default ramp-in / ramp-out duration on each side of a voice region (ms). */
const DEFAULT_FADE_MS = 180;
/** Default VAD threshold — matches AudioIntelligence's "Speech" preset. */
const DEFAULT_THRESHOLD = 0.05;
/** Default VAD min-duration — matches AudioIntelligence's "Speech" preset. */
const DEFAULT_MIN_DURATION_MS = 600;

export interface AutoZoomKeyframe {
  /** Time relative to the target clip's start, in ms. */
  t: number;
  /** Scale value (1.0 = original size). */
  v: number;
  easing?: KeyframeEasing;
}

export interface AutoZoomUpdate {
  /** Target clip id. */
  clipId: string;
  /** Scale-X keyframes to write (clip-relative time). */
  scaleXKfs: AutoZoomKeyframe[];
  /** Scale-Y keyframes to write (clip-relative time). */
  scaleYKfs: AutoZoomKeyframe[];
}

export interface ComputeAutoZoomOpts {
  /** Peak zoom factor at the apex of a voice region. Default 1.08. */
  zoomFactor?: number;
  /** Ramp duration on each side of a voice region, in ms. Default 180. */
  fadeMs?: number;
  /** VAD energy threshold (0..1). Default 0.05. */
  threshold?: number;
  /** Minimum sustained voice activity in ms before counting as a region. Default 600. */
  minDurationMs?: number;
}

/**
 * Compute punch-in zoom keyframes for every visually-overlapping video clip.
 *
 * Steps:
 *   1. Trim the waveform to the voice clip's source-window so VAD only sees
 *      what the user actually plays. (We mirror the existing pattern used by
 *      AutoDuckSection — denominator pinned to `source_out_ms`. This is
 *      consistent with the rest of the panel even though it's not strictly
 *      tied to the full asset duration.)
 *   2. Run detectVoiceActivity → list of timeline-time voice regions.
 *   3. For every clip on a non-voice TRACK that overlaps any voice region,
 *      emit 4 keyframes per region: a 1.0 → zoom ramp-in, hold-at-zoom,
 *      then zoom → 1.0 ramp-out. Keyframes are stored in CLIP-RELATIVE time
 *      because that's what the keyframe runtime expects.
 *
 * Returns one update entry per matching clip (clips that don't overlap any
 * voice region are omitted entirely — there's nothing to do for them).
 */
export function computeAutoZoomKeyframes(
  voiceClip: Clip,
  waveform: number[],
  allClips: readonly Clip[],
  opts?: ComputeAutoZoomOpts,
): AutoZoomUpdate[] {
  const zoomFactor = opts?.zoomFactor ?? DEFAULT_ZOOM_FACTOR;
  const fadeMs = Math.max(1, opts?.fadeMs ?? DEFAULT_FADE_MS);
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const minDurationMs = opts?.minDurationMs ?? DEFAULT_MIN_DURATION_MS;

  if (!waveform || waveform.length === 0) return [];
  if (voiceClip.duration_ms <= 0) return [];

  // Step 1 — trim the waveform to the clip's source window. Same arithmetic as
  // AutoDuckSection so the result feels consistent with the existing duck UX.
  const denom = Math.max(1, voiceClip.source_out_ms);
  const startIdx = Math.max(0, Math.floor((voiceClip.source_in_ms / denom) * waveform.length));
  const endIdx = Math.max(startIdx + 1, Math.floor((voiceClip.source_out_ms / denom) * waveform.length));
  const subWave = waveform.slice(startIdx, endIdx);

  // Step 2 — detect voice activity in TIMELINE time.
  const voiceRegions: DuckSegment[] = detectVoiceActivity(
    subWave,
    voiceClip.start_time_ms,
    voiceClip.duration_ms,
    { threshold, minDurationMs },
  );
  if (voiceRegions.length === 0) return [];

  // Step 3 — for every clip on a DIFFERENT track from the voice clip, emit
  // keyframes for every voice region that overlaps the clip's timeline range.
  const updates: AutoZoomUpdate[] = [];
  for (const target of allClips) {
    if (target.id === voiceClip.id) continue;
    if (target.track_id === voiceClip.track_id) continue;

    const tStart = target.start_time_ms;
    const tEnd = target.start_time_ms + target.duration_ms;
    if (tEnd <= tStart) continue;

    const overlaps = voiceRegions.filter((v) => v.endMs > tStart && v.startMs < tEnd);
    if (overlaps.length === 0) continue;

    const kfs = buildKeyframesForClip(target, overlaps, zoomFactor, fadeMs);
    if (kfs.length === 0) continue;

    updates.push({
      clipId: target.id,
      scaleXKfs: kfs,
      // Scale Y mirrors scale X — a punch-in zooms uniformly, not anamorphically.
      scaleYKfs: kfs.map((k) => ({ ...k })),
    });
  }

  return updates;
}

/**
 * Build per-clip keyframes from the list of overlapping voice regions.
 *
 * For each region we emit four keyframes in CLIP-RELATIVE ms:
 *   - (relStart - fadeMs, 1.0, ease-out)   start the ramp-in
 *   - (relStart,           zoom, linear)    hit the apex
 *   - (relEnd,             zoom, ease-in)   begin ramp-out
 *   - (relEnd   + fadeMs,  1.0,  linear)    settle back
 *
 * Clamp to [0, duration] so we never write a keyframe outside the clip — the
 * keyframe runtime clamps at evaluation time anyway, but clean data is easier
 * to inspect in the keyframe editor.
 *
 * If multiple voice regions are close enough that their fades would overlap,
 * we collapse touching/overlapping keyframes via `dedupeKeyframes` so the
 * resulting curve is monotonic.
 */
function buildKeyframesForClip(
  clip: Clip,
  overlaps: readonly DuckSegment[],
  zoomFactor: number,
  fadeMs: number,
): AutoZoomKeyframe[] {
  const out: AutoZoomKeyframe[] = [];
  const dur = clip.duration_ms;

  for (const region of overlaps) {
    // Clamp region to the visible portion of the clip on the timeline.
    const tlStart = Math.max(region.startMs, clip.start_time_ms);
    const tlEnd = Math.min(region.endMs, clip.start_time_ms + dur);
    if (tlEnd <= tlStart) continue;

    const relStart = tlStart - clip.start_time_ms;
    const relEnd = tlEnd - clip.start_time_ms;

    const rampInStart = clampMs(relStart - fadeMs, 0, dur);
    const apexStart = clampMs(relStart, 0, dur);
    const apexEnd = clampMs(relEnd, 0, dur);
    const rampOutEnd = clampMs(relEnd + fadeMs, 0, dur);

    out.push({ t: rampInStart, v: 1.0, easing: 'ease-out' });
    out.push({ t: apexStart, v: zoomFactor, easing: 'linear' });
    out.push({ t: apexEnd, v: zoomFactor, easing: 'ease-in' });
    out.push({ t: rampOutEnd, v: 1.0, easing: 'linear' });
  }

  return dedupeKeyframes(out);
}

/**
 * Sort, then collapse keyframes that share a time-slot (within 1ms). The later
 * value wins — this happens when two voice regions are so close that one
 * region's ramp-out fights the next region's ramp-in. We want the zoom to
 * stay HIGH in those cases (so the camera doesn't pump), so when both a 1.0
 * keyframe and a zoom keyframe land on the same `t`, the zoom value wins.
 */
function dedupeKeyframes(kfs: AutoZoomKeyframe[]): AutoZoomKeyframe[] {
  if (kfs.length === 0) return kfs;
  const sorted = [...kfs].sort((a, b) => a.t - b.t);
  const merged: AutoZoomKeyframe[] = [];
  for (const k of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.t - k.t) < 1) {
      // Keep whichever value is FURTHEST from 1.0 — i.e. prefer the punch-in.
      const prevDist = Math.abs(prev.v - 1.0);
      const curDist = Math.abs(k.v - 1.0);
      if (curDist >= prevDist) {
        merged[merged.length - 1] = { ...k, t: prev.t };
      }
      continue;
    }
    merged.push(k);
  }
  return merged;
}

function clampMs(t: number, lo: number, hi: number): number {
  if (t < lo) return lo;
  if (t > hi) return hi;
  return t;
}

/**
 * Convenience: convert an array of {t,v,easing} into the `Keyframe[]` shape
 * stored on a clip's effects_json `keyframes` track. Provided as a sister
 * helper so callers don't need to massage the types manually.
 */
export function toKeyframes(arr: readonly AutoZoomKeyframe[]): Keyframe[] {
  return arr.map((k) => ({ t: k.t, v: k.v, easing: k.easing ?? 'linear' }));
}
