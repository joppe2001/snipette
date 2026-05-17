/**
 * Audio-analysis primitives used by the Audio Intelligence panel.
 *
 * Operates on the normalized waveform array (~600 samples per asset, 0..1 amplitudes)
 * exposed by `window.snipette.media.waveform(assetId)`. All time math is in milliseconds
 * — silence regions are reported in SOURCE time (relative to the asset start) while
 * voice activity is reported in TIMELINE time (relative to project start).
 */

export interface SilenceRegion {
  /** Time within the clip's source (NOT timeline) in ms. */
  startMs: number;
  endMs: number;
}

export interface DuckSegment {
  /** Timeline time, ms. */
  startMs: number;
  endMs: number;
}

interface DetectSilenceOpts {
  threshold?: number;
  minDurationMs?: number;
  paddingMs?: number;
}

interface DetectVoiceOpts {
  threshold?: number;
  minDurationMs?: number;
}

const DEFAULT_SILENCE_THRESHOLD = 0.04;
const DEFAULT_SILENCE_MIN_MS = 400;
const DEFAULT_SILENCE_PADDING_MS = 80;
const DEFAULT_VOICE_MIN_MS = 250;

/**
 * Detect silent regions in a waveform array (normalized 0..1 amplitudes). A region is
 * considered "silent" when its amplitude stays below `threshold` for at least
 * `minDurationMs`. Regions are shrunk by `paddingMs` on each side so we don't cut off the
 * breath in/out around the silent gap.
 */
export function detectSilence(
  waveform: number[],
  totalDurationMs: number,
  opts?: DetectSilenceOpts,
): SilenceRegion[] {
  const threshold = opts?.threshold ?? DEFAULT_SILENCE_THRESHOLD;
  const minDurationMs = opts?.minDurationMs ?? DEFAULT_SILENCE_MIN_MS;
  const paddingMs = opts?.paddingMs ?? DEFAULT_SILENCE_PADDING_MS;

  if (waveform.length === 0 || totalDurationMs <= 0) return [];

  const msPerSample = totalDurationMs / waveform.length;
  const regions: SilenceRegion[] = [];
  let runStart: number | null = null;

  for (let i = 0; i < waveform.length; i++) {
    const isQuiet = waveform[i] < threshold;
    if (isQuiet && runStart === null) {
      runStart = i;
    } else if (!isQuiet && runStart !== null) {
      pushRegion(regions, runStart, i, msPerSample, minDurationMs, paddingMs);
      runStart = null;
    }
  }
  if (runStart !== null) {
    pushRegion(regions, runStart, waveform.length, msPerSample, minDurationMs, paddingMs);
  }

  return regions;
}

function pushRegion(
  out: SilenceRegion[],
  startSample: number,
  endSampleExclusive: number,
  msPerSample: number,
  minDurationMs: number,
  paddingMs: number,
): void {
  const rawStart = startSample * msPerSample;
  const rawEnd = endSampleExclusive * msPerSample;
  const rawDuration = rawEnd - rawStart;
  if (rawDuration < minDurationMs) return;
  const startMs = rawStart + paddingMs;
  const endMs = rawEnd - paddingMs;
  if (endMs - startMs <= 0) return;
  out.push({ startMs, endMs });
}

/**
 * Convert silence regions (in source-time) to a list of "keep" regions — the inverse —
 * which are the speech chunks we want to retain when auto-cutting silence.
 */
export function invertRegions(
  regions: SilenceRegion[],
  totalDurationMs: number,
): SilenceRegion[] {
  if (totalDurationMs <= 0) return [];
  const sorted = [...regions].sort((a, b) => a.startMs - b.startMs);
  const keeps: SilenceRegion[] = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.startMs > cursor) {
      keeps.push({ startMs: cursor, endMs: Math.min(r.startMs, totalDurationMs) });
    }
    cursor = Math.max(cursor, r.endMs);
  }
  if (cursor < totalDurationMs) {
    keeps.push({ startMs: cursor, endMs: totalDurationMs });
  }
  return keeps.filter((k) => k.endMs - k.startMs > 0);
}

/**
 * Compute ducking segments: where on the timeline a voice clip is loud enough to be
 * "active speech". Music tracks that overlap these segments should be ducked at export
 * time. Returns LOUD regions in TIMELINE-time (the inverse of silence detection mapped
 * to absolute project time).
 */
export function detectVoiceActivity(
  waveform: number[],
  clipStartTimelineMs: number,
  clipDurationMs: number,
  opts?: DetectVoiceOpts,
): DuckSegment[] {
  const threshold = opts?.threshold ?? DEFAULT_SILENCE_THRESHOLD;
  const minDurationMs = opts?.minDurationMs ?? DEFAULT_VOICE_MIN_MS;

  if (waveform.length === 0 || clipDurationMs <= 0) return [];

  const msPerSample = clipDurationMs / waveform.length;
  const segments: DuckSegment[] = [];
  let runStart: number | null = null;

  for (let i = 0; i < waveform.length; i++) {
    const isLoud = waveform[i] >= threshold;
    if (isLoud && runStart === null) {
      runStart = i;
    } else if (!isLoud && runStart !== null) {
      pushVoiceSegment(segments, runStart, i, msPerSample, clipStartTimelineMs, minDurationMs);
      runStart = null;
    }
  }
  if (runStart !== null) {
    pushVoiceSegment(
      segments,
      runStart,
      waveform.length,
      msPerSample,
      clipStartTimelineMs,
      minDurationMs,
    );
  }

  return segments;
}

function pushVoiceSegment(
  out: DuckSegment[],
  startSample: number,
  endSampleExclusive: number,
  msPerSample: number,
  clipStartTimelineMs: number,
  minDurationMs: number,
): void {
  const localStart = startSample * msPerSample;
  const localEnd = endSampleExclusive * msPerSample;
  if (localEnd - localStart < minDurationMs) return;
  out.push({
    startMs: clipStartTimelineMs + localStart,
    endMs: clipStartTimelineMs + localEnd,
  });
}
