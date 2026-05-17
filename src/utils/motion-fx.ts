/**
 * Clip-level motion effects: shake, zoom pulse, Ken Burns, float, etc. Each clip's
 * `effects_json` is an array of MotionEffect entries. computeMotionFxVisual composes them
 * into a transform string + filter overrides for the preview canvas.
 */

export type MotionFxType =
  | 'shake'
  | 'zoom-pulse'
  | 'ken-burns'
  | 'float'
  | 'jitter'
  | 'spin-drift'
  | 'rgb-shift'
  | 'flash'
  | 'vignette'
  | 'blur'
  | 'sharpen'
  | 'pixelate'
  | 'mirror-x'
  | 'mirror-y'
  | 'kaleidoscope'
  | 'vhs'
  | 'dream-glow'
  | 'chromatic-strobe'
  | 'scan-lines'
  | 'vortex'
  | 'wave-distort';

export interface MotionEffect {
  type: MotionFxType;
  /** Intensity 0..1; defaults to 0.5 if missing. */
  intensity?: number;
}

export interface MotionFxVisual {
  transform: string;
  filter?: string;
}

const IDLE: MotionFxVisual = { transform: '' };

const MOTION_FX_TYPES: Set<string> = new Set<string>([
  'shake',
  'zoom-pulse',
  'ken-burns',
  'float',
  'jitter',
  'spin-drift',
  'rgb-shift',
  'flash',
  'vignette',
  'blur',
  'sharpen',
  'pixelate',
  'mirror-x',
  'mirror-y',
  'kaleidoscope',
  'vhs',
  'dream-glow',
  'chromatic-strobe',
  'scan-lines',
  'vortex',
  'wave-distort',
] satisfies MotionFxType[]);

/** True iff the given string is a motion-FX type defined in {@link MOTION_FX_LIBRARY}. */
export function isMotionFxType(type: string): type is MotionFxType {
  return MOTION_FX_TYPES.has(type);
}

export function parseEffects(json: string | null | undefined): MotionEffect[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (Array.isArray(raw)) {
      return raw.filter((e) => typeof e === 'object' && e && typeof (e as MotionEffect).type === 'string') as MotionEffect[];
    }
  } catch {
    // ignore
  }
  return [];
}

export function serializeEffects(effects: MotionEffect[]): string {
  return JSON.stringify(effects);
}

/**
 * Compute the composed transform for a clip given:
 *   relativeMs — playhead − clip.start_time_ms
 *   durationMs — total duration of the clip (used for Ken Burns to know how far to zoom).
 */
export function computeMotionFx(
  effects: MotionEffect[],
  relativeMs: number,
  durationMs: number,
): MotionFxVisual {
  if (effects.length === 0) return IDLE;
  const t = relativeMs / 1000;
  const transforms: string[] = [];
  const filters: string[] = [];

  for (const e of effects) {
    const i = clamp(e.intensity ?? 0.5, 0, 1);
    switch (e.type) {
      case 'shake': {
        // Pseudo-random shake; sums of sines at different frequencies.
        const amp = 6 * i;
        const x = (Math.sin(t * 32) + Math.sin(t * 47 + 1.2)) * amp;
        const y = (Math.cos(t * 39) + Math.sin(t * 53 + 0.7)) * amp * 0.7;
        transforms.push(`translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`);
        break;
      }
      case 'zoom-pulse': {
        const amp = 0.04 + i * 0.06;
        const s = 1 + Math.sin(t * 4.2) * amp;
        transforms.push(`scale(${s.toFixed(4)})`);
        break;
      }
      case 'ken-burns': {
        // Linear zoom from 1 → 1+0.15·i over the clip duration, with a slow pan.
        const p = clamp(relativeMs / Math.max(1, durationMs), 0, 1);
        const s = 1 + p * (0.1 + i * 0.2);
        const panX = (p - 0.5) * 60 * i;
        const panY = (p - 0.5) * 30 * i;
        transforms.push(`translate(${panX.toFixed(2)}px, ${panY.toFixed(2)}px) scale(${s.toFixed(4)})`);
        break;
      }
      case 'float': {
        const amp = 4 + i * 6;
        const y = Math.sin(t * 1.5) * amp;
        transforms.push(`translateY(${y.toFixed(2)}px)`);
        break;
      }
      case 'jitter': {
        const amp = 0.8 + i * 1.6;
        const x = (Math.sin(t * 60) + Math.cos(t * 53)) * amp;
        const y = (Math.cos(t * 71) - Math.sin(t * 89)) * amp;
        transforms.push(`translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`);
        break;
      }
      case 'spin-drift': {
        // Very slow rotation: 360° per 30 seconds at full intensity.
        const r = (t * (12 * i)) % 360;
        transforms.push(`rotate(${r.toFixed(2)}deg)`);
        break;
      }
      case 'rgb-shift': {
        // Approximate chromatic aberration: pair drop-shadow filters red + cyan offset.
        const off = 1 + i * 4;
        filters.push(`drop-shadow(${off}px 0 0 rgba(242,58,94,0.55)) drop-shadow(${-off}px 0 0 rgba(58,200,242,0.55))`);
        break;
      }
      case 'flash': {
        // Periodic brightness pulse.
        const b = 1 + (Math.sin(t * 6) * 0.5 + 0.5) * (0.6 + i);
        filters.push(`brightness(${b.toFixed(3)})`);
        break;
      }
      case 'vignette': {
        // Approximation: CSS can't draw a true corner vignette, so we slightly darken
        // and add contrast. The real (corner-only) version is baked at export time.
        const b = 1 - i * 0.1;
        const c = 1 + i * 0.15;
        filters.push(`brightness(${b.toFixed(3)}) contrast(${c.toFixed(3)})`);
        break;
      }
      case 'blur': {
        const px = i * 6;
        filters.push(`blur(${px.toFixed(2)}px)`);
        break;
      }
      case 'sharpen': {
        // CSS has no real sharpen — approximate via contrast + saturation lift.
        const c = 1 + i * 0.3;
        const s = 1 + i * 0.2;
        filters.push(`contrast(${c.toFixed(3)}) saturate(${s.toFixed(3)})`);
        break;
      }
      case 'pixelate': {
        // Approximation in CSS — true pixelation handled at export time.
        const px = i * 1.5;
        const c = 1 + i * 0.5;
        filters.push(`blur(${px.toFixed(2)}px) contrast(${c.toFixed(3)})`);
        break;
      }
      case 'mirror-x': {
        // Binary flip; intensity is ignored for direction but kept for API consistency.
        transforms.push('scaleX(-1)');
        break;
      }
      case 'mirror-y': {
        transforms.push('scaleY(-1)');
        break;
      }
      case 'kaleidoscope': {
        // CSS approximation: slow rotate + saturation bump. Real quad-reflection is export-only.
        const r = (t * 30) % 360;
        const s = 0.9 + i * 0.2;
        const sat = 1 + i;
        transforms.push(`rotate(${r.toFixed(2)}deg) scale(${s.toFixed(4)})`);
        filters.push(`saturate(${sat.toFixed(3)})`);
        break;
      }
      case 'vhs': {
        // VHS look: muted saturation, slight contrast, rgb shift via drop-shadows, sinusoidal wobble.
        const off = 1 + i * 2;
        const x = Math.sin(t * 3) * i * 1.5;
        const sat = 0.85;
        const con = 1.1;
        transforms.push(`translateX(${x.toFixed(2)}px)`);
        filters.push(
          `saturate(${sat.toFixed(2)}) contrast(${con.toFixed(2)}) drop-shadow(${off.toFixed(2)}px 0 0 rgba(242,58,94,0.45)) drop-shadow(${(-off).toFixed(2)}px 0 0 rgba(58,200,242,0.45))`,
        );
        break;
      }
      case 'dream-glow': {
        // Soft white halo bloom.
        const b = 1 + i * 0.15;
        const sat = 0.95;
        const blr = i * 0.5;
        const halo = i * 16;
        filters.push(
          `brightness(${b.toFixed(3)}) saturate(${sat.toFixed(2)}) blur(${blr.toFixed(2)}px) drop-shadow(0 0 ${halo.toFixed(2)}px rgba(255,255,255,0.5))`,
        );
        break;
      }
      case 'chromatic-strobe': {
        // RGB shift whose strength pulses fast.
        const pulse = Math.abs(Math.sin(t * 8));
        const off = 1 + pulse * (1 + i * 4);
        filters.push(
          `drop-shadow(${off.toFixed(2)}px 0 0 rgba(242,58,94,0.6)) drop-shadow(${(-off).toFixed(2)}px 0 0 rgba(58,200,242,0.6))`,
        );
        break;
      }
      case 'scan-lines': {
        // Approximation: subtle high-frequency brightness modulation.
        const b = 0.95 + Math.sin(t * 40) * 0.05 * i;
        filters.push(`brightness(${b.toFixed(3)})`);
        break;
      }
      case 'vortex': {
        // Slow rotation + zoom pulse combo.
        const r = (t * 30 * i) % 360;
        const s = 1 + Math.sin(t * 2) * 0.05 * i;
        transforms.push(`rotate(${r.toFixed(2)}deg) scale(${s.toFixed(4)})`);
        break;
      }
      case 'wave-distort': {
        // Sinusoidal scale on x/y (asymmetric to read as a wobble).
        const sx = 1 + Math.sin(t * 4) * 0.04 * i;
        const sy = 1 + Math.cos(t * 4) * 0.04 * i;
        transforms.push(`scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`);
        break;
      }
    }
  }

  return {
    transform: transforms.join(' '),
    filter: filters.join(' ') || undefined,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export const MOTION_FX_LIBRARY: { type: MotionFxType; name: string; description: string; defaultIntensity: number }[] = [
  { type: 'shake', name: 'Shake', description: 'Tactile camera shake', defaultIntensity: 0.5 },
  { type: 'zoom-pulse', name: 'Zoom Pulse', description: 'Pulsing zoom in/out', defaultIntensity: 0.6 },
  { type: 'ken-burns', name: 'Ken Burns', description: 'Slow zoom + pan over the clip', defaultIntensity: 0.6 },
  { type: 'float', name: 'Float', description: 'Gentle vertical drift', defaultIntensity: 0.5 },
  { type: 'jitter', name: 'Jitter', description: 'Fine high-frequency wobble', defaultIntensity: 0.4 },
  { type: 'spin-drift', name: 'Spin Drift', description: 'Slow continuous rotation', defaultIntensity: 0.4 },
  { type: 'rgb-shift', name: 'RGB Shift', description: 'Chromatic aberration', defaultIntensity: 0.55 },
  { type: 'flash', name: 'Flash', description: 'Pulsing brightness', defaultIntensity: 0.45 },
  { type: 'vignette', name: 'Vignette', description: 'Darkened corners (approx in preview)', defaultIntensity: 0.6 },
  { type: 'blur', name: 'Blur', description: 'Gaussian-style soft focus', defaultIntensity: 0.4 },
  { type: 'sharpen', name: 'Sharpen', description: 'Crisper edges and color', defaultIntensity: 0.5 },
  { type: 'pixelate', name: 'Pixelate', description: 'Chunky mosaic (approx in preview)', defaultIntensity: 0.6 },
  { type: 'mirror-x', name: 'Mirror X', description: 'Flip horizontally', defaultIntensity: 1 },
  { type: 'mirror-y', name: 'Mirror Y', description: 'Flip vertically', defaultIntensity: 1 },
  { type: 'kaleidoscope', name: 'Kaleidoscope', description: 'Rotating mirrored reflections (approx)', defaultIntensity: 0.55 },
  { type: 'vhs', name: 'VHS', description: 'Retro tape look', defaultIntensity: 0.55 },
  { type: 'dream-glow', name: 'Dream Glow', description: 'Soft white halo bloom', defaultIntensity: 0.5 },
  { type: 'chromatic-strobe', name: 'Chromatic Strobe', description: 'Pulsing RGB shift', defaultIntensity: 0.55 },
  { type: 'scan-lines', name: 'Scan Lines', description: 'CRT scanline modulation (approx)', defaultIntensity: 0.5 },
  { type: 'vortex', name: 'Vortex', description: 'Slow spin + zoom pulse', defaultIntensity: 0.5 },
  { type: 'wave-distort', name: 'Wave Distort', description: 'Sinusoidal wobble', defaultIntensity: 0.5 },
];
