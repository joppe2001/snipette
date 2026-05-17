/**
 * Live auto-duck computation. Replaces the old "bake volume keyframes into the music
 * clip" approach so the duck always follows the voice clip's CURRENT position on the
 * timeline — moving / trimming voice no longer leaves stale duck zones behind.
 *
 * Source of truth: voice clips carry an `audio-duck-source` effect entry whose
 * `windows` are stored relative to the voice clip's start_time_ms. Music clips carry
 * an `audio-duck-target` flag with `ducked_volume`. At preview time we sample all
 * voice clips, translate their relative windows into timeline-time using each clip's
 * live position, and return a 0..1 multiplier for the given playhead.
 *
 * Fade shape matches what the AudioIntelligence panel describes: 300 ms attack with
 * 150 ms predictive lookahead, 600 ms release, asymmetric.
 */

import type { Clip } from '@shared/types';

export interface RelativeVoiceWindow {
  /** Milliseconds from the voice clip's start_time_ms. */
  relStartMs: number;
  relEndMs: number;
}

export interface TimelineWindow {
  startMs: number;
  endMs: number;
}

const LOOKAHEAD_MS = 150;
const ATTACK_MS = 300;
const RELEASE_MS = 600;

/** Pull all duck-source windows from a clip and translate to timeline time. */
export function timelineWindowsForVoice(clip: Clip): TimelineWindow[] {
  if (!clip.effects_json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(clip.effects_json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: TimelineWindow[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    if ((entry as { type?: unknown }).type !== 'audio-duck-source') continue;
    const params = (entry as { params?: { windows?: unknown } }).params;
    const windows = params?.windows;
    if (!Array.isArray(windows)) continue;
    for (const w of windows) {
      if (!w || typeof w !== 'object') continue;
      const rs = (w as { relStartMs?: unknown }).relStartMs;
      const re = (w as { relEndMs?: unknown }).relEndMs;
      if (typeof rs === 'number' && typeof re === 'number') {
        out.push({ startMs: clip.start_time_ms + rs, endMs: clip.start_time_ms + re });
      }
    }
  }
  return out;
}

/**
 * Module-level cache for `readDuckTarget` results, keyed by the raw effects_json string.
 * The hot path (PreviewCanvas per-RAF) calls this for every music clip every frame; the
 * underlying JSON.parse + Array.find is pure-of-input, so memoising by the string itself
 * lets us return the previously-decoded answer in O(1). Bounded so a long editing session
 * with thousands of distinct effects_json values can't grow the map unbounded.
 *
 * `null` is a legitimate cached answer (clip is not a duck target), distinct from "miss".
 */
const DUCK_TARGET_CACHE = new Map<string, number | null>();
const DUCK_TARGET_CACHE_MAX = 256;

/** Read the ducked target volume from a music clip's effects_json. Returns null if not a duck target. */
export function readDuckTarget(effectsJson: string | null | undefined): number | null {
  if (!effectsJson) return null;
  const cached = DUCK_TARGET_CACHE.get(effectsJson);
  if (cached !== undefined) return cached;
  let result: number | null = null;
  try {
    const parsed = JSON.parse(effectsJson);
    if (Array.isArray(parsed)) {
      const entry = parsed.find(
        (e) => e && typeof e === 'object' && (e as { type?: unknown }).type === 'audio-duck-target',
      );
      if (entry) {
        const dv = (entry as { params?: { ducked_volume?: unknown } }).params?.ducked_volume;
        result = typeof dv === 'number' ? dv : 0.3;
      }
    }
  } catch {
    result = null;
  }
  // Simple FIFO eviction when full — avoids a heavier LRU for what is effectively a hot
  // cache of "the few effects_json strings currently on the timeline".
  if (DUCK_TARGET_CACHE.size >= DUCK_TARGET_CACHE_MAX) {
    const firstKey = DUCK_TARGET_CACHE.keys().next().value;
    if (firstKey !== undefined) DUCK_TARGET_CACHE.delete(firstKey);
  }
  DUCK_TARGET_CACHE.set(effectsJson, result);
  return result;
}

/**
 * Compute the duck-multiplier at the given playhead time given a list of timeline
 * windows where voice is active. Returns 1.0 (no duck) when far from any window,
 * `duckedVolume` when inside one, with eased ramps on either side.
 *
 * Predictive: the ducked level is reached LOOKAHEAD_MS before the window starts.
 */
export function duckLevelAt(
  playheadMs: number,
  voiceWindows: TimelineWindow[],
  duckedVolume: number,
): number {
  let minLevel = 1;
  for (const w of voiceWindows) {
    const settledAt = w.startMs - LOOKAHEAD_MS;
    const preDip = settledAt - ATTACK_MS;
    const postDip = w.endMs + RELEASE_MS;
    if (playheadMs < preDip || playheadMs > postDip) continue;
    let level: number;
    if (playheadMs >= settledAt && playheadMs <= w.endMs) {
      level = duckedVolume;
    } else if (playheadMs < settledAt) {
      // Attack ramp, ease-out (1 - (1-t)^2): starts dropping fast, settles smoothly.
      const t = (playheadMs - preDip) / ATTACK_MS;
      const eased = 1 - (1 - t) * (1 - t);
      level = 1 + (duckedVolume - 1) * eased;
    } else {
      // Release ramp, ease-in (t^2): holds quiet briefly, then lifts.
      const t = (playheadMs - w.endMs) / RELEASE_MS;
      const eased = t * t;
      level = duckedVolume + (1 - duckedVolume) * eased;
    }
    if (level < minLevel) minLevel = level;
  }
  return minLevel;
}

/** Convenience: full pipeline from raw clip list to multiplier for one music clip. */
export function duckMultiplierForMusic(
  playheadMs: number,
  musicClip: Clip,
  allClips: readonly Clip[],
): number {
  const ducked = readDuckTarget(musicClip.effects_json);
  if (ducked === null) return 1;
  const allWindows: TimelineWindow[] = [];
  for (const c of allClips) {
    if (c.id === musicClip.id) continue;
    const ws = timelineWindowsForVoice(c);
    for (const w of ws) allWindows.push(w);
  }
  if (allWindows.length === 0) return 1;
  return duckLevelAt(playheadMs, allWindows, ducked);
}

/**
 * Precomputed plan of every voice-duck window currently on the timeline, in timeline-time.
 * Built ONCE per clip-list change and reused for every music clip at every preview tick,
 * eliminating the O(N) JSON.parse loop that used to run inside the render-frame hot path.
 */
export interface DuckPlan {
  voiceWindows: TimelineWindow[];
}

/**
 * Walk all clips ONCE, parse their effects_json, and extract every `audio-duck-source`
 * window translated into timeline time. The resulting plan is intended to be memoised
 * by the caller (e.g. PreviewCanvas) on `[clips]` and passed into `duckMultiplierFromPlan`
 * for each music clip on every render tick.
 *
 * Excluding a clip from the plan (e.g. the music clip itself) is unnecessary because
 * music clips don't carry `audio-duck-source` entries — they carry `audio-duck-target`.
 */
export function buildDuckPlan(allClips: readonly Clip[]): DuckPlan {
  const voiceWindows: TimelineWindow[] = [];
  for (const c of allClips) {
    const ws = timelineWindowsForVoice(c);
    for (const w of ws) voiceWindows.push(w);
  }
  return { voiceWindows };
}

/**
 * Hot-path variant of `duckMultiplierForMusic` that reuses a precomputed `DuckPlan` and
 * the cached `readDuckTarget` result. Intended for the per-RAF preview loop where the
 * clip list rarely changes but the playhead advances every frame.
 */
export function duckMultiplierFromPlan(
  playheadMs: number,
  musicClip: Clip,
  plan: DuckPlan,
): number {
  const ducked = readDuckTarget(musicClip.effects_json);
  if (ducked === null) return 1;
  if (plan.voiceWindows.length === 0) return 1;
  return duckLevelAt(playheadMs, plan.voiceWindows, ducked);
}
