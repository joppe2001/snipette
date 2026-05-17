/**
 * Speed ramp presets. Each preset emits a set of `speed` keyframes that span the clip's
 * duration, producing cinematic speed curves (slow-mo, whoosh, hyperlapse, etc.) instead
 * of constant `clip.speed`.
 *
 * Keyframes are written to `effects_json` via `writeKeyframes()` on the 'speed' track.
 * PreviewCanvas reads them through `valueAt()` per playhead tick.
 */

import type { Keyframe } from './keyframes';

export interface SpeedRampPreset {
  id: string;
  name: string;
  description: string;
  /** Generate a list of keyframes spanning [0, durationMs]. */
  build(durationMs: number): Keyframe[];
}

const SPEED_MIN = 0.25;
const SPEED_MAX = 4;

function clampSpeed(v: number): number {
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, v));
}

/**
 * Helper: build a sane keyframe list from (t, v, easing) tuples, clamped to legal speed
 * range and the clip duration. Avoids hand-rolling clamps in every preset.
 */
function ramp(durationMs: number, points: Array<[fraction: number, value: number, easing?: Keyframe['easing']]>): Keyframe[] {
  const safeDuration = Math.max(1, durationMs);
  return points.map(([frac, v, easing]) => ({
    t: Math.round(Math.max(0, Math.min(1, frac)) * safeDuration),
    v: clampSpeed(v),
    easing: easing ?? 'linear',
  }));
}

export const SPEED_RAMP_PRESETS: SpeedRampPreset[] = [
  {
    id: 'drop',
    name: 'Drop',
    description: 'Fast → slow at the impact → fast. Beat-drop staple.',
    build: (d) => ramp(d, [
      [0, 1.75, 'ease-in'],
      [0.45, 0.4, 'ease-out'],
      [0.55, 0.4, 'ease-in'],
      [1, 1.75, 'linear'],
    ]),
  },
  {
    id: 'whoosh-in',
    name: 'Whoosh-In',
    description: 'Slow start that snaps to normal — emphasizes a reveal.',
    build: (d) => ramp(d, [
      [0, 0.35, 'ease-in'],
      [0.35, 0.4, 'hold'],
      [0.45, 1, 'linear'],
      [1, 1, 'linear'],
    ]),
  },
  {
    id: 'whoosh-out',
    name: 'Whoosh-Out',
    description: 'Normal → slows to a crawl at the tail. Cliffhanger ending.',
    build: (d) => ramp(d, [
      [0, 1, 'linear'],
      [0.6, 1, 'ease-in'],
      [1, 0.3, 'linear'],
    ]),
  },
  {
    id: 'pulse',
    name: 'Pulse',
    description: '1× → 0.5× at midpoint → 1×. Heart-skip on the beat.',
    build: (d) => ramp(d, [
      [0, 1, 'ease-in-out'],
      [0.5, 0.5, 'ease-in-out'],
      [1, 1, 'linear'],
    ]),
  },
  {
    id: 'hyperlapse',
    name: 'Hyperlapse',
    description: 'Linear ramp from 1× to 4×. Time-lapse acceleration.',
    build: (d) => ramp(d, [
      [0, 1, 'linear'],
      [1, 4, 'linear'],
    ]),
  },
  {
    id: 'bullet-time',
    name: 'Bullet Time',
    description: 'Normal → freeze-frame slow → resume. Matrix moment.',
    build: (d) => ramp(d, [
      [0, 1, 'ease-in'],
      [0.4, 0.25, 'hold'],
      [0.6, 0.25, 'ease-out'],
      [1, 1, 'linear'],
    ]),
  },
];

export function findPreset(id: string): SpeedRampPreset | undefined {
  return SPEED_RAMP_PRESETS.find((p) => p.id === id);
}
