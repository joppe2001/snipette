// Pure-math helpers for professional editing operations: ripple delete, slip, slide.
// These functions accept clips/parameters and return new shapes — no side effects, no IPC,
// no store mutation. Callers (the store actions / drag handlers) decide how to apply them.
//
// Exception: a few async helpers at the bottom orchestrate IPC + store ops for context-menu
// actions (e.g. freezeFrameAt). They are clearly marked and isolated from the pure section.

import type { Clip } from '@shared/types';
import { useTimelineStore } from '@/store/timeline.store';
import { parseEffectsArray, isAudioFxType } from '@/utils/audio-fx';

export interface RippleResult {
  /** Clips to delete (their ids). */
  toDelete: string[];
  /** Clips to update with new start_time_ms. */
  toShift: { id: string; new_start_ms: number }[];
}

/**
 * Compute the ripple-delete effect: delete the targeted clips, then close gaps by shifting
 * every later clip on each affected track earlier by the accumulated deleted duration.
 *
 * Algorithm:
 *  - Group clips per track.
 *  - For each track, walk left-to-right by start_time_ms.
 *  - Whenever a deleted clip is encountered, accumulate its duration_ms onto a running
 *    "shift" counter. Every subsequent (non-deleted) clip on that track gets its start
 *    pushed earlier by the current shift.
 *
 * This treats overlapping/adjacent deletions correctly: removing 3 back-to-back clips
 * closes the full gap, not just the first one.
 */
export function computeRippleDelete(allClips: Clip[], targetIds: string[]): RippleResult {
  const targetSet = new Set(targetIds);
  const toDelete: string[] = [];
  const toShift: { id: string; new_start_ms: number }[] = [];

  // Bucket clips by track for independent processing.
  const byTrack = new Map<string, Clip[]>();
  for (const clip of allClips) {
    const bucket = byTrack.get(clip.track_id);
    if (bucket) {
      bucket.push(clip);
    } else {
      byTrack.set(clip.track_id, [clip]);
    }
  }

  for (const bucket of byTrack.values()) {
    // Stable left-to-right ordering on the timeline.
    const ordered = [...bucket].sort((a, b) => a.start_time_ms - b.start_time_ms);
    let shift = 0;
    let trackTouched = false;
    for (const clip of ordered) {
      if (targetSet.has(clip.id)) {
        toDelete.push(clip.id);
        shift += clip.duration_ms;
        trackTouched = true;
        continue;
      }
      if (trackTouched && shift > 0) {
        const new_start_ms = Math.max(0, clip.start_time_ms - shift);
        if (new_start_ms !== clip.start_time_ms) {
          toShift.push({ id: clip.id, new_start_ms });
        }
      }
    }
  }

  return { toDelete, toShift };
}

export interface SlipResult {
  source_in_ms: number;
  source_out_ms: number;
}

/**
 * Slip the clip's source window by `deltaMs`.
 *
 * Positive delta = look forward into the source (source_in/out increase = show later content).
 * Negative delta = look backward (source_in/out decrease = show earlier content).
 *
 * The window size (source_out_ms - source_in_ms) is preserved exactly so the timeline
 * footprint of the clip does NOT change. If a clamp is required at one boundary
 * (in < 0 or out > sourceDurationMs), the entire window slides by the same amount so
 * the size stays constant.
 */
export function computeSlip(clip: Clip, deltaMs: number, sourceDurationMs: number): SlipResult {
  const windowSize = Math.max(0, clip.source_out_ms - clip.source_in_ms);
  const maxOut = Math.max(windowSize, sourceDurationMs);

  let newIn = clip.source_in_ms + deltaMs;
  let newOut = clip.source_out_ms + deltaMs;

  // Clamp left boundary: if we'd go negative, slide the whole window forward so size stays put.
  if (newIn < 0) {
    newIn = 0;
    newOut = windowSize;
  }

  // Clamp right boundary: if we overshoot the source end, slide the window backward.
  if (newOut > maxOut) {
    const overshoot = newOut - maxOut;
    newOut = maxOut;
    newIn = Math.max(0, newIn - overshoot);
    // If the source is shorter than the window (degenerate), pin to [0, maxOut].
    if (newOut - newIn < windowSize) {
      newIn = Math.max(0, maxOut - windowSize);
      newOut = maxOut;
    }
  }

  return { source_in_ms: newIn, source_out_ms: newOut };
}

export interface SlideResult {
  /** New start for the slid clip. Its duration and source window stay unchanged. */
  clipId: string;
  new_start_ms: number;
  /** Previous clip (on the same track), if present — its source_out / duration is extended/shrunk. */
  prevUpdate: { id: string; duration_ms: number; source_out_ms: number } | null;
  /** Next clip (on the same track), if present — its start / source_in is shifted to fill. */
  nextUpdate: { id: string; start_time_ms: number; duration_ms: number; source_in_ms: number } | null;
}

/**
 * Slide a clip between its neighbors on the same track. The clip's source window and duration
 * are preserved; the adjacent clips have their durations/source-edges flexed to keep the timeline
 * contiguous.
 *
 * Not wired into the UI in v1 — exposed here so the math is unit-testable and future-ready.
 * A real slide implementation needs UI affordances (showing the affected neighbors), so it's
 * deferred until that is in place.
 */
export function computeSlide(
  clip: Clip,
  deltaMs: number,
  allClips: Clip[],
): SlideResult {
  const sameTrack = allClips
    .filter((c) => c.track_id === clip.track_id && c.id !== clip.id)
    .sort((a, b) => a.start_time_ms - b.start_time_ms);
  const prev = sameTrack.filter((c) => c.start_time_ms + c.duration_ms <= clip.start_time_ms).pop() ?? null;
  const next = sameTrack.find((c) => c.start_time_ms >= clip.start_time_ms + clip.duration_ms) ?? null;

  // Bounds: can't slide further left than prev's start; can't slide further right than next's end.
  const minStart = prev ? prev.start_time_ms : 0;
  const maxStart = next ? next.start_time_ms + next.duration_ms - clip.duration_ms : clip.start_time_ms + deltaMs;
  const proposed = clip.start_time_ms + deltaMs;
  const new_start = Math.max(minStart, Math.min(maxStart, proposed));
  const actualDelta = new_start - clip.start_time_ms;

  let prevUpdate: SlideResult['prevUpdate'] = null;
  if (prev) {
    const newPrevDuration = Math.max(50, prev.duration_ms + actualDelta);
    const newPrevSourceOut = prev.source_in_ms + newPrevDuration * (prev.speed || 1);
    prevUpdate = { id: prev.id, duration_ms: newPrevDuration, source_out_ms: newPrevSourceOut };
  }

  let nextUpdate: SlideResult['nextUpdate'] = null;
  if (next) {
    const newNextStart = next.start_time_ms + actualDelta;
    const newNextDuration = Math.max(50, next.duration_ms - actualDelta);
    const newNextSourceIn = next.source_in_ms + actualDelta * (next.speed || 1);
    nextUpdate = {
      id: next.id,
      start_time_ms: newNextStart,
      duration_ms: newNextDuration,
      source_in_ms: newNextSourceIn,
    };
  }

  return { clipId: clip.id, new_start_ms: new_start, prevUpdate, nextUpdate };
}

// ---------------------------------------------------------------------------
// effects_json sanitizers — pure string in, pure string out.
// Used by the clip context menu's "Clear keyframes" / "Clear effects" actions.
// ---------------------------------------------------------------------------

/**
 * Strip the `keyframes` entry from `effects_json`, preserving all other entries.
 * Returns a JSON string. If the input is empty/malformed or has no entries left,
 * returns '[]'.
 */
export function clearKeyframesFromEffects(effectsJson: string | null | undefined): string {
  const entries = parseEffectsArray(effectsJson);
  const kept = entries.filter((e) => e.type !== 'keyframes');
  return JSON.stringify(kept);
}

/**
 * Strip motion-fx entries from `effects_json`. Preserves: `keyframes`, any audio FX
 * (anything `isAudioFxType` accepts), `audio-normalize`, `audio-duck-source`,
 * `audio-duck-target`, and `filter-preset`. Everything else is treated as motion FX
 * and removed.
 */
export function clearMotionEffectsFromEffects(effectsJson: string | null | undefined): string {
  const entries = parseEffectsArray(effectsJson);
  const kept = entries.filter((e) => {
    if (e.type === 'keyframes') return true;
    if (e.type === 'filter-preset') return true;
    if (e.type === 'audio-normalize') return true;
    if (e.type === 'audio-duck-source') return true;
    if (e.type === 'audio-duck-target') return true;
    if (isAudioFxType(e.type)) return true;
    return false;
  });
  return JSON.stringify(kept);
}

// ---------------------------------------------------------------------------
// Async orchestrators — these call IPC and update the zustand store. Kept here
// so context-menu wiring stays a one-liner; the math/intent is still in one place.
// ---------------------------------------------------------------------------

/**
 * Split the clip at `atMs` (timeline coords) and turn the right half's first
 * `durationMs` into a still frame: source_out_ms = source_in_ms, duration_ms =
 * durationMs. History is snapshotted before the split so a single undo restores
 * the original clip.
 *
 * NOTE: This implementation does NOT ripple subsequent clips. If the freeze
 * extends past the next clip on the same track, callers should expect overlap.
 * (Truncation/ripple is deferred — handled by the broader ripple feature.)
 */
export async function freezeFrameAt(
  clipId: string,
  atMs: number,
  durationMs = 1000,
): Promise<void> {
  const store = useTimelineStore.getState();
  store.pushHistory();
  const [left, right] = await window.snipette.timeline.splitClip(clipId, atMs);
  store.replaceClip(left);
  store.addClip(right);
  const freezeUpdates: Partial<Clip> = {
    source_out_ms: right.source_in_ms,
    duration_ms: durationMs,
  };
  const frozen = await window.snipette.timeline.updateClip(right.id, freezeUpdates);
  store.replaceClip(frozen);
  store.computeDuration();
}
