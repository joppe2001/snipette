import { useCallback, useMemo } from 'react';
import { useTimelineStore } from '@/store/timeline.store';
import { msToPx, pxToMs } from '@/utils/time';

export interface TimelineGeometry {
  timeToX: (ms: number) => number;
  xToTime: (px: number) => number;
  /** Optionally pass `excludeClipId` so the clip being dragged doesn't snap to
   *  its own original start/end (which would feel like "the drag never moves"
   *  for sub-threshold motion). */
  snapTime: (ms: number, excludeClipId?: string) => number;
}

/**
 * Pure rendering geometry: zoom + scroll only — no `clips` or `markers` subscription.
 *
 * Why this matters: every TrackRow / ClipBlock / TimelineRuler / Playhead / MarkerLayer /
 * TransitionMarker subscribes to this hook. If it also subscribed to `clips`, every clip
 * mutation (drag, trim, keyframe tick) would re-render every consumer of the hook.
 *
 * `snapTime` is still exposed for backward-compat, but it reads `clips` / `markers` /
 * `playheadMs` lazily via `useTimelineStore.getState()` inside the callback — so it can
 * use the freshest snap points without forcing a subscription on this hook's consumers.
 * Snap is only invoked from drag handlers (imperatively), so React reactivity to the
 * snap-point list isn't required.
 */
export function useTimelineGeometry(): TimelineGeometry {
  const zoom = useTimelineStore((s) => s.zoomLevel);
  const scroll = useTimelineStore((s) => s.scrollOffsetMs);
  const snapEnabled = useTimelineStore((s) => s.snapEnabled);
  const threshold = useTimelineStore((s) => s.snapThresholdPx);

  const timeToX = useCallback((ms: number) => msToPx(ms, zoom, scroll), [zoom, scroll]);
  const xToTime = useCallback((px: number) => pxToMs(px, zoom, scroll), [zoom, scroll]);

  const snapTime = useCallback(
    (ms: number, excludeClipId?: string) => {
      if (!snapEnabled) return ms;
      const state = useTimelineStore.getState();
      const thresholdMs = (threshold / zoom) * 1000;
      let best = ms;
      let bestDiff = thresholdMs;
      // Project start
      {
        const d = Math.abs(ms - 0);
        if (d < bestDiff) {
          bestDiff = d;
          best = 0;
        }
      }
      for (const c of state.clips) {
        // Skip the clip currently being dragged — otherwise it snaps to its own
        // original edges, freezing the drag for small movements.
        if (excludeClipId && c.id === excludeClipId) continue;
        const s1 = c.start_time_ms;
        const d1 = Math.abs(ms - s1);
        if (d1 < bestDiff) {
          bestDiff = d1;
          best = s1;
        }
        const s2 = c.start_time_ms + c.duration_ms;
        const d2 = Math.abs(ms - s2);
        if (d2 < bestDiff) {
          bestDiff = d2;
          best = s2;
        }
      }
      for (const m of state.markers) {
        const d = Math.abs(ms - m.time_ms);
        if (d < bestDiff) {
          bestDiff = d;
          best = m.time_ms;
        }
      }
      const live = state.playheadMs;
      const dLive = Math.abs(ms - live);
      if (dLive < bestDiff) best = live;
      return best;
    },
    [snapEnabled, threshold, zoom],
  );

  // Memoize the returned object literal so downstream `useMemo([geometry])` /
  // `React.memo` comparisons hold across re-renders that don't actually change
  // any of the callback identities.
  return useMemo(() => ({ timeToX, xToTime, snapTime }), [timeToX, xToTime, snapTime]);
}

/**
 * Snap-only hook — returns a snap function that subscribes to `clips` and `markers`
 * if you want React-driven invalidation on snap-point changes. Most call-sites should
 * use `useTimelineGeometry().snapTime` (which reads via getState lazily); this hook
 * exists for any consumer that needs the snap function identity to change when the
 * snap-point list changes.
 */
export function useTimelineSnap(): { snapTime: (ms: number) => number } {
  const snapEnabled = useTimelineStore((s) => s.snapEnabled);
  const threshold = useTimelineStore((s) => s.snapThresholdPx);
  const zoom = useTimelineStore((s) => s.zoomLevel);
  const clips = useTimelineStore((s) => s.clips);
  const markers = useTimelineStore((s) => s.markers);

  const snapPoints = useMemo(() => {
    const points: number[] = [0];
    for (const c of clips) {
      points.push(c.start_time_ms);
      points.push(c.start_time_ms + c.duration_ms);
    }
    for (const m of markers) {
      points.push(m.time_ms);
    }
    return points;
  }, [clips, markers]);

  const snapTime = useCallback(
    (ms: number) => {
      if (!snapEnabled) return ms;
      const thresholdMs = (threshold / zoom) * 1000;
      let best = ms;
      let bestDiff = thresholdMs;
      for (const p of snapPoints) {
        const d = Math.abs(ms - p);
        if (d < bestDiff) {
          bestDiff = d;
          best = p;
        }
      }
      const live = useTimelineStore.getState().playheadMs;
      const dLive = Math.abs(ms - live);
      if (dLive < bestDiff) best = live;
      return best;
    },
    [snapEnabled, snapPoints, threshold, zoom],
  );

  return useMemo(() => ({ snapTime }), [snapTime]);
}
