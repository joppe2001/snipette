/** Format a millisecond duration as `HH:MM:SS` or `MM:SS`. */
export function formatTime(ms: number, withHours = false): string {
  const totalS = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (withHours || h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/** Format with frames: `MM:SS:FF` */
export function formatTimecode(ms: number, fps = 30): string {
  const totalS = Math.floor(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  const f = Math.floor(((ms % 1000) / 1000) * fps);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(m)}:${pad(s)}:${pad(f)}`;
}

/**
 * Format `MM:SS / MM:SS`. Switches to `HH:MM:SS` if either side passes the hour mark — so
 * short clips stay compact in the playback overlay.
 */
export function formatTimePair(ms: number, totalMs: number): string {
  const withHours = Math.max(ms, totalMs) >= 3_600_000;
  return `${formatTime(ms, withHours)} / ${formatTime(totalMs, withHours)}`;
}

export function pxPerSecondToMsPerPx(pxPerSecond: number): number {
  return 1000 / pxPerSecond;
}

export function msToPx(ms: number, zoom: number, scrollOffsetMs = 0): number {
  return ((ms - scrollOffsetMs) / 1000) * zoom;
}

export function pxToMs(px: number, zoom: number, scrollOffsetMs = 0): number {
  return (px / zoom) * 1000 + scrollOffsetMs;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * When clip speed changes, the timeline footprint should shrink/grow to match. The amount
 * of source consumed (source_out_ms − source_in_ms) is fixed; only how fast the clip plays
 * changes. So timeline duration = source window / speed.
 */
export function durationForSpeed(sourceInMs: number, sourceOutMs: number, speed: number): number {
  const safeSpeed = Math.max(0.05, speed);
  const window = Math.max(1, sourceOutMs - sourceInMs);
  return Math.max(50, Math.round(window / safeSpeed));
}

export function relativeTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  const w = Math.floor(d / 7);
  if (w === 1) return '1 week';
  return `${w} weeks ago`;
}
