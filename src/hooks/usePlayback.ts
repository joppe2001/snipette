import { useEffect, useRef } from 'react';
import { useTimelineStore } from '@/store/timeline.store';

/**
 * RequestAnimationFrame-based playhead driver. The actual video element sync happens
 * in the PreviewCanvas (it owns the <video> tags) — this hook just advances the playhead.
 *
 * Behavior notes:
 *  - If `togglePlay` fires while the playhead is at the end, we rewind to 0 first.
 *  - If the user scrubs during playback (external `setPlayhead`), we re-anchor the wall-time so
 *    the RAF loop continues from the new position instead of jumping back.
 */
export function usePlayback(): void {
  const isPlaying = useTimelineStore((s) => s.isPlaying);
  const durationMs = useTimelineStore((s) => s.durationMs);
  const pause = useTimelineStore((s) => s.pause);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const startWallTime = useRef<number>(0);
  const startPlayhead = useRef<number>(0);
  const expectedPlayhead = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    if (durationMs <= 0) {
      setPlayhead(0);
      pause();
      return;
    }

    const reanchor = (from: number) => {
      startWallTime.current = performance.now();
      startPlayhead.current = from;
      expectedPlayhead.current = from;
    };

    let initial = useTimelineStore.getState().playheadMs;
    // Replay from start if user hits play at the very end.
    if (initial >= durationMs - 1) {
      initial = 0;
      setPlayhead(0);
    }
    reanchor(initial);

    const tick = () => {
      const state = useTimelineStore.getState();
      // Detect external scrubs: if the playhead diverges from our expected value by >40 ms,
      // the user has scrubbed — re-anchor instead of pulling them back.
      if (Math.abs(state.playheadMs - expectedPlayhead.current) > 40) {
        reanchor(state.playheadMs);
      }
      const elapsed = performance.now() - startWallTime.current;
      const next = startPlayhead.current + elapsed;
      if (next >= durationMs) {
        setPlayhead(durationMs);
        pause();
        rafRef.current = null;
        return;
      }
      expectedPlayhead.current = next;
      setPlayhead(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isPlaying, durationMs, pause, setPlayhead]);
}
