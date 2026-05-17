import type { Clip, Transition } from '@shared/types';

/**
 * Mask region for transitions that reveal via clipping (wipe, iris). All percentages
 * are relative to the rendering box.
 *  - `inset`: rectangular reveal — `topPct/rightPct/bottomPct/leftPct` chop those amounts
 *    off the corresponding side, mirroring CSS `inset(top right bottom left)`.
 *  - `circle`: circular reveal — `radiusPct` follows CSS rules where 100% =
 *    `sqrt(W² + H²) / sqrt(2)` (so ~70.7% covers a rectangular box exactly).
 */
export type TransitionClipShape =
  | { kind: 'inset'; topPct: number; rightPct: number; bottomPct: number; leftPct: number }
  | { kind: 'circle'; radiusPct: number; cxPct: number; cyPct: number };

export interface TransitionVisual {
  /** Multiplied with the clip's own opacity. */
  opacity: number;
  /** Extra transform appended to the clip's own translate/scale/rotate. */
  transform: string;
  /** Optional CSS filter to mix in (e.g. glitch hue shift). */
  filter?: string;
  /** z-index hint — incoming clips should sit on top of outgoing ones for slide/zoom. */
  zIndex?: number;
  /** Clip mask region for reveal-style transitions (wipe, iris). */
  clipShape?: TransitionClipShape;
}

const IDLE: TransitionVisual = { opacity: 1, transform: '', zIndex: undefined };

/** Window of a transition centered on the boundary between its two clips. */
export function transitionWindow(transition: Transition, a: Clip, b: Clip): { startMs: number; endMs: number; outgoing: Clip; incoming: Clip } {
  const earlier = a.start_time_ms <= b.start_time_ms ? a : b;
  const later = earlier === a ? b : a;
  const boundary = earlier.start_time_ms + earlier.duration_ms;
  const half = transition.duration_ms / 2;
  return {
    startMs: boundary - half,
    endMs: boundary + half,
    outgoing: earlier,
    incoming: later,
  };
}

/**
 * For a given playhead time + transition list, compute the visual state of every clip that
 * participates in an active transition. Returns:
 *  - A map of clipId → visual style overrides (opacity, transform, filter, zIndex)
 *  - A set of clipIds that must be force-rendered even if outside their normal time range
 *    (the incoming clip during the first half of a transition is one such case)
 */
/**
 * Multiplier in [0, 1] for overlays (text, stickers) that should fade in step with the
 * adjacent clip transition. Returns 1 when no transition is active (no fade), drops to 0
 * at the midpoint of the most-aggressive overlapping transition, and rises back to 1 at
 * the edges. Lets overlays "leave with" the outgoing clip and "arrive with" the incoming.
 */
export function transitionFadeMultiplier(
  playheadMs: number,
  clips: Clip[],
  transitions: Transition[],
): number {
  let minMult = 1;
  for (const tr of transitions) {
    const a = clips.find((c) => c.id === tr.clip_a_id);
    const b = clips.find((c) => c.id === tr.clip_b_id);
    if (!a || !b) continue;
    const earlier = a.start_time_ms <= b.start_time_ms ? a : b;
    const boundary = earlier.start_time_ms + earlier.duration_ms;
    const half = tr.duration_ms / 2;
    const startMs = boundary - half;
    const endMs = boundary + half;
    if (playheadMs < startMs || playheadMs > endMs) continue;
    const dur = Math.max(1, endMs - startMs);
    const p = Math.min(1, Math.max(0, (playheadMs - startMs) / dur));
    // V-shape: 1 at p=0, 0 at p=0.5, 1 at p=1.
    const mult = Math.abs(2 * p - 1);
    if (mult < minMult) minMult = mult;
  }
  return minMult;
}

export function computeTransitionStates(
  playheadMs: number,
  clips: Clip[],
  transitions: Transition[],
): { byClip: Map<string, TransitionVisual>; forceRender: Set<string> } {
  const byClip = new Map<string, TransitionVisual>();
  const forceRender = new Set<string>();

  for (const tr of transitions) {
    const a = clips.find((c) => c.id === tr.clip_a_id);
    const b = clips.find((c) => c.id === tr.clip_b_id);
    if (!a || !b) continue;
    const { startMs, endMs, outgoing, incoming } = transitionWindow(tr, a, b);
    if (playheadMs < startMs || playheadMs > endMs) continue;
    const dur = Math.max(1, endMs - startMs);
    const p = Math.min(1, Math.max(0, (playheadMs - startMs) / dur));
    byClip.set(outgoing.id, outgoingStyle(tr.type, p));
    byClip.set(incoming.id, incomingStyle(tr.type, p));
    forceRender.add(outgoing.id);
    forceRender.add(incoming.id);
  }

  void IDLE;
  return { byClip, forceRender };
}

function outgoingStyle(type: string, p: number): TransitionVisual {
  switch (type) {
    case 'cut':
      return { opacity: p < 0.5 ? 1 : 0, transform: '' };
    case 'dissolve':
    case 'fade':
      return { opacity: 1 - p, transform: '' };
    case 'slide':
      return { opacity: 1, transform: `translateX(${-100 * p}%)` };
    case 'push':
      // Outgoing is pushed by the incoming — same direction but tied to B's motion.
      return { opacity: 1, transform: `translateX(${-100 * p}%)` };
    case 'wipe':
      // Linear reveal: B is masked from the right, sweeping left→right; A sits underneath
      // fully visible the whole time and is uncovered as B advances. So outgoing has no
      // transform / opacity change — only the incoming's clip changes.
      return { opacity: 1, transform: '' };
    case 'iris':
      // Circular reveal: A stays in place fully visible; B is masked to an expanding
      // circle. Outgoing has no clip — incoming carries the geometry.
      return { opacity: 1, transform: '' };
    case 'smooth':
      return { opacity: 1 - p * 0.5, transform: `translateX(${-50 * p}%)`, filter: `blur(${p * 2}px)` };
    case 'zoom':
      return { opacity: 1 - p, transform: `scale(${1 + p * 0.4})` };
    case 'glitch': {
      const jitter = (Math.sin(p * 60) + Math.sin(p * 37 + 1.7)) * 6 * (1 - p);
      const flicker = 1 - p + Math.sin(p * 80) * 0.15;
      return {
        opacity: Math.max(0, Math.min(1, flicker)),
        transform: `translateX(${jitter}px)`,
        filter: `hue-rotate(${p * 90}deg)`,
      };
    }
    case 'whip':
      return {
        opacity: p < 0.85 ? 1 : 0,
        transform: `translateX(${-200 * p}%)`,
        filter: p > 0.05 ? `blur(${p * 6}px)` : undefined,
      };
    case 'spin':
      return {
        opacity: 1 - p,
        transform: `rotate(${360 * p}deg) scale(${1 - p * 0.4})`,
      };
    case 'bounce': {
      const s = 1 - Math.sin(p * Math.PI) * 0.6;
      return { opacity: 1 - p, transform: `scale(${s})` };
    }
    default:
      return { opacity: 1 - p, transform: '' };
  }
}

function incomingStyle(type: string, p: number): TransitionVisual {
  switch (type) {
    case 'cut':
      return { opacity: p < 0.5 ? 0 : 1, transform: '' };
    case 'dissolve':
    case 'fade':
      return { opacity: p, transform: '' };
    case 'slide':
      return { opacity: 1, transform: `translateX(${100 * (1 - p)}%)`, zIndex: 10 };
    case 'push':
      // Push: B drives in from right, mirrors A's exit. Slightly faster easing for energy.
      return { opacity: 1, transform: `translateX(${100 * (1 - p)}%)`, zIndex: 10 };
    case 'wipe':
      // Linear left→right reveal. Right side is initially fully masked; as p → 1 the
      // mask shrinks to nothing and B is fully shown.
      return {
        opacity: 1,
        transform: '',
        zIndex: 10,
        clipShape: {
          kind: 'inset',
          topPct: 0,
          rightPct: (1 - p) * 100,
          bottomPct: 0,
          leftPct: 0,
        },
      };
    case 'iris':
      // Circle expanding from center. At p=1 the radius reaches ~70.7% of the reference
      // diagonal length, which CSS resolves to exactly cover a rectangular box.
      return {
        opacity: 1,
        transform: '',
        zIndex: 10,
        clipShape: {
          kind: 'circle',
          radiusPct: p * 70.7106781,
          cxPct: 50,
          cyPct: 50,
        },
      };
    case 'smooth':
      return {
        opacity: p,
        transform: `translateX(${50 * (1 - p)}%)`,
        filter: `blur(${(1 - p) * 2}px)`,
        zIndex: 10,
      };
    case 'zoom':
      return { opacity: p, transform: `scale(${0.6 + p * 0.4})`, zIndex: 10 };
    case 'glitch': {
      const jitter = (Math.cos(p * 60) + Math.cos(p * 41 + 0.4)) * 6 * p;
      const flicker = p + Math.sin(p * 80 + 1.5) * 0.15;
      return {
        opacity: Math.max(0, Math.min(1, flicker)),
        transform: `translateX(${jitter}px)`,
        filter: `hue-rotate(${(1 - p) * 90}deg)`,
        zIndex: 10,
      };
    }
    case 'whip':
      return {
        opacity: p > 0.15 ? 1 : 0,
        transform: `translateX(${200 * (1 - p)}%)`,
        filter: p < 0.95 ? `blur(${(1 - p) * 6}px)` : undefined,
        zIndex: 10,
      };
    case 'spin':
      return {
        opacity: p,
        transform: `rotate(${-360 * (1 - p)}deg) scale(${0.6 + p * 0.4})`,
        zIndex: 10,
      };
    case 'bounce': {
      const s = Math.sin(p * Math.PI) + (1 - Math.sin(p * Math.PI)) * p;
      return { opacity: p, transform: `scale(${s})`, zIndex: 10 };
    }
    default:
      return { opacity: p, transform: '' };
  }
}
