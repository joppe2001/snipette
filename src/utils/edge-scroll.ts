/**
 * Pointer-drag edge auto-scroll. While the user is dragging anything (a clip, a trim
 * handle, an asset from the media library) and their pointer drifts near the edge of a
 * scrollable container, advance `scrollLeft` continuously so they can keep dragging
 * past the visible region instead of releasing and re-grabbing.
 *
 * Usage:
 *   on pointer move:  updateEdgeScroll(container, e.clientX, onScrolled)
 *   on pointer up:    stopEdgeScroll()
 *
 * The `onScrolled` callback fires after every rAF step where scrollLeft actually
 * advanced — the caller uses it to re-run their drag math so the dragged content
 * keeps following the cursor's TIME (not just its viewport-x).
 *
 * Module-level state intentionally — only one drag interaction can be active at a
 * time per pointer, and these handlers are global.
 */

interface ScrollState {
  scrollEl: HTMLElement;
  direction: -1 | 0 | 1;
  /** 0..1; higher when pointer is right at the edge, lower further from it. */
  intensity: number;
  maxSpeed: number;
  onScrolled?: () => void;
}

let state: ScrollState | null = null;
let raf: number | null = null;

function tick(): void {
  if (!state || state.direction === 0) {
    raf = null;
    return;
  }
  const before = state.scrollEl.scrollLeft;
  const proposed = before + state.direction * state.maxSpeed * state.intensity;
  // Clamp at the natural scroll bounds so we don't fight the browser.
  const max = state.scrollEl.scrollWidth - state.scrollEl.clientWidth;
  const next = Math.max(0, Math.min(max, proposed));
  state.scrollEl.scrollLeft = next;
  if (next === before) {
    // Already at a scroll bound — stop ticking.
    raf = null;
    return;
  }
  state.onScrolled?.();
  raf = requestAnimationFrame(tick);
}

/**
 * Update the edge-scroll state based on where the pointer currently is. Call this on
 * every pointer-move event during a drag. The util figures out whether the pointer is
 * inside an edge zone and starts/stops the scroll loop as needed.
 */
export function updateEdgeScroll(
  scrollEl: HTMLElement,
  pointerX: number,
  onScrolled?: () => void,
  opts?: { edgeZonePx?: number; maxSpeedPxPerFrame?: number },
): void {
  const edgeZonePx = opts?.edgeZonePx ?? 60;
  const maxSpeed = opts?.maxSpeedPxPerFrame ?? 24;
  const rect = scrollEl.getBoundingClientRect();
  const distFromLeft = pointerX - rect.left;
  const distFromRight = rect.right - pointerX;

  let direction: -1 | 0 | 1 = 0;
  let intensity = 0;
  if (distFromLeft < edgeZonePx) {
    direction = -1;
    // Clamp negative distance (pointer slightly outside the body) to full intensity.
    intensity = Math.min(1, Math.max(0, 1 - Math.max(0, distFromLeft) / edgeZonePx));
  } else if (distFromRight < edgeZonePx) {
    direction = 1;
    intensity = Math.min(1, Math.max(0, 1 - Math.max(0, distFromRight) / edgeZonePx));
  }

  state = { scrollEl, direction, intensity, maxSpeed, onScrolled };
  if (direction !== 0 && raf === null) {
    raf = requestAnimationFrame(tick);
  }
}

/** Stop the auto-scroll loop. Safe to call when nothing is running. */
export function stopEdgeScroll(): void {
  state = null;
  if (raf !== null) cancelAnimationFrame(raf);
  raf = null;
}
