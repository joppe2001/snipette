/**
 * Beat-Sync Auto-Cut — given a list of beat times (timeline ms) and a target
 * clip, return the SPLIT POINTS that fall strictly inside the clip's timeline
 * range. The caller then iterates the returned points and applies them via
 * `window.snipette.timeline.splitClip`.
 *
 * Pure module — no IPC, no React, no store mutations. Designed to be reused by
 * the panel UI but also testable in isolation.
 */

import type { Clip } from '@shared/types';

/** Minimum half-piece duration (ms). Splits closer than this to either edge are dropped. */
const MIN_PIECE_MS = 40;

/**
 * Return the subset of `beatsMs` that fall strictly inside the clip's timeline
 * window. Beats coinciding with the clip's start or end are filtered out —
 * splitting at the very edge would create a zero-width piece, which the
 * timeline backend rejects anyway. We use a small epsilon so floating-point
 * jitter near the boundary doesn't slip through.
 *
 * Output is sorted ascending and deduplicated within MIN_PIECE_MS so we don't
 * issue back-to-back splits that would produce useless ~1ms pieces.
 */
export function beatsWithinClip(beatsMs: readonly number[], clip: Clip): number[] {
  if (!beatsMs || beatsMs.length === 0) return [];
  if (clip.duration_ms <= 2 * MIN_PIECE_MS) return [];

  const start = clip.start_time_ms;
  const end = clip.start_time_ms + clip.duration_ms;
  const lo = start + MIN_PIECE_MS;
  const hi = end - MIN_PIECE_MS;

  const inRange = beatsMs.filter((t) => Number.isFinite(t) && t > lo && t < hi);
  inRange.sort((a, b) => a - b);

  const out: number[] = [];
  for (const t of inRange) {
    const prev = out[out.length - 1];
    if (prev !== undefined && t - prev < MIN_PIECE_MS) continue;
    out.push(t);
  }
  return out;
}

/**
 * Compute the list of video clips that should be split, with the timeline-time
 * split points for each. Excludes the music clip itself and anything on its
 * track. Useful for previews (count the affected clips) and for the apply
 * step (iterate and call splitClip).
 *
 * Splits are paired with their clip's `id` rather than the clip itself because
 * the clip references go stale as we split — the caller must re-fetch the
 * live clip from the store on each iteration.
 */
export interface BeatCutPlan {
  clipId: string;
  splitPointsMs: number[];
}

export function computeBeatCutPlan(
  beatsTimelineMs: readonly number[],
  musicClip: Clip,
  allClips: readonly Clip[],
  videoTrackIds: ReadonlySet<string>,
): BeatCutPlan[] {
  if (!beatsTimelineMs || beatsTimelineMs.length === 0) return [];

  const musicStart = musicClip.start_time_ms;
  const musicEnd = musicClip.start_time_ms + musicClip.duration_ms;

  const plans: BeatCutPlan[] = [];
  for (const c of allClips) {
    if (c.id === musicClip.id) continue;
    if (!videoTrackIds.has(c.track_id)) continue;

    // Only consider video clips that visually overlap the music clip's range.
    const cStart = c.start_time_ms;
    const cEnd = c.start_time_ms + c.duration_ms;
    if (cEnd <= musicStart || cStart >= musicEnd) continue;

    const splits = beatsWithinClip(beatsTimelineMs, c);
    if (splits.length === 0) continue;

    plans.push({ clipId: c.id, splitPointsMs: splits });
  }

  return plans;
}

/**
 * Convert beat times from SOURCE-ms (relative to the asset) into TIMELINE-ms,
 * accounting for the clip's source-in offset and playback speed.
 *
 * Mirrors the arithmetic used by BeatDetectionSection.addBeatsAsMarkers in
 * AudioIntelligence so beat-sync auto-cut and beat markers line up perfectly.
 */
export function beatsSourceToTimeline(sourceBeatsMs: readonly number[], clip: Clip): number[] {
  const speed = Math.max(0.05, clip.speed);
  return sourceBeatsMs
    .filter((t) => t >= clip.source_in_ms && t <= clip.source_out_ms)
    .map((t) => clip.start_time_ms + (t - clip.source_in_ms) / speed);
}
