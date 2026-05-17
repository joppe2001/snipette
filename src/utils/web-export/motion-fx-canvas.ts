/**
 * Canvas2D twin of {@link computeMotionFx}. The preview renders motion FX as CSS
 * `transform` + `filter` strings. The canvas pipeline needs the same math expressed as
 * Canvas2D ops:
 *   - transform → a 2D affine matrix applied via ctx.transform(a,b,c,d,e,f)
 *   - filter → a `ctx.filter` string (Chromium supports the same subset CSS does)
 *
 * Some preview-only approximations (e.g. kaleidoscope's quad-reflection, real pixelation,
 * a true corner vignette) still render as their CSS-style approximation. The handoff calls
 * those out — when we exit Phase 7, we can replace them with proper canvas implementations.
 */

import type { MotionEffect } from '@/utils/motion-fx';

export interface MotionFxCanvas {
  /** Multiplied with ctx's current transform. translate-px / scale / rotate-rad. */
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  rotateRad: number;
  /** Filter string compatible with `ctx.filter`. Empty string = none. */
  filter: string;
}

const IDLE: MotionFxCanvas = {
  translateX: 0,
  translateY: 0,
  scaleX: 1,
  scaleY: 1,
  rotateRad: 0,
  filter: '',
};

export function computeMotionFxCanvas(
  effects: MotionEffect[],
  relativeMs: number,
  durationMs: number,
): MotionFxCanvas {
  if (effects.length === 0) return { ...IDLE };

  const t = relativeMs / 1000;
  const out: MotionFxCanvas = { ...IDLE };
  const filters: string[] = [];

  for (const e of effects) {
    const i = clamp(e.intensity ?? 0.5, 0, 1);
    switch (e.type) {
      case 'shake': {
        const amp = 6 * i;
        out.translateX += (Math.sin(t * 32) + Math.sin(t * 47 + 1.2)) * amp;
        out.translateY += (Math.cos(t * 39) + Math.sin(t * 53 + 0.7)) * amp * 0.7;
        break;
      }
      case 'zoom-pulse': {
        const amp = 0.04 + i * 0.06;
        const s = 1 + Math.sin(t * 4.2) * amp;
        out.scaleX *= s;
        out.scaleY *= s;
        break;
      }
      case 'ken-burns': {
        const p = clamp(relativeMs / Math.max(1, durationMs), 0, 1);
        const s = 1 + p * (0.1 + i * 0.2);
        out.translateX += (p - 0.5) * 60 * i;
        out.translateY += (p - 0.5) * 30 * i;
        out.scaleX *= s;
        out.scaleY *= s;
        break;
      }
      case 'float': {
        const amp = 4 + i * 6;
        out.translateY += Math.sin(t * 1.5) * amp;
        break;
      }
      case 'jitter': {
        const amp = 0.8 + i * 1.6;
        out.translateX += (Math.sin(t * 60) + Math.cos(t * 53)) * amp;
        out.translateY += (Math.cos(t * 71) - Math.sin(t * 89)) * amp;
        break;
      }
      case 'spin-drift': {
        const r = (t * (12 * i)) % 360;
        out.rotateRad += (r * Math.PI) / 180;
        break;
      }
      case 'rgb-shift': {
        const off = 1 + i * 4;
        filters.push(
          `drop-shadow(${off}px 0 0 rgba(242,58,94,0.55)) drop-shadow(${-off}px 0 0 rgba(58,200,242,0.55))`,
        );
        break;
      }
      case 'flash': {
        const b = 1 + (Math.sin(t * 6) * 0.5 + 0.5) * (0.6 + i);
        filters.push(`brightness(${b.toFixed(3)})`);
        break;
      }
      case 'vignette': {
        const b = 1 - i * 0.1;
        const c = 1 + i * 0.15;
        filters.push(`brightness(${b.toFixed(3)}) contrast(${c.toFixed(3)})`);
        break;
      }
      case 'blur': {
        filters.push(`blur(${(i * 6).toFixed(2)}px)`);
        break;
      }
      case 'sharpen': {
        const c = 1 + i * 0.3;
        const s = 1 + i * 0.2;
        filters.push(`contrast(${c.toFixed(3)}) saturate(${s.toFixed(3)})`);
        break;
      }
      case 'pixelate': {
        const px = i * 1.5;
        const c = 1 + i * 0.5;
        filters.push(`blur(${px.toFixed(2)}px) contrast(${c.toFixed(3)})`);
        break;
      }
      case 'mirror-x':
        out.scaleX *= -1;
        break;
      case 'mirror-y':
        out.scaleY *= -1;
        break;
      case 'kaleidoscope': {
        const r = (t * 30) % 360;
        const s = 0.9 + i * 0.2;
        out.rotateRad += (r * Math.PI) / 180;
        out.scaleX *= s;
        out.scaleY *= s;
        filters.push(`saturate(${(1 + i).toFixed(3)})`);
        break;
      }
      case 'vhs': {
        const off = 1 + i * 2;
        out.translateX += Math.sin(t * 3) * i * 1.5;
        filters.push(
          `saturate(0.85) contrast(1.10) drop-shadow(${off.toFixed(2)}px 0 0 rgba(242,58,94,0.45)) drop-shadow(${(-off).toFixed(2)}px 0 0 rgba(58,200,242,0.45))`,
        );
        break;
      }
      case 'dream-glow': {
        const b = 1 + i * 0.15;
        const blr = i * 0.5;
        const halo = i * 16;
        filters.push(
          `brightness(${b.toFixed(3)}) saturate(0.95) blur(${blr.toFixed(2)}px) drop-shadow(0 0 ${halo.toFixed(2)}px rgba(255,255,255,0.5))`,
        );
        break;
      }
      case 'chromatic-strobe': {
        const pulse = Math.abs(Math.sin(t * 8));
        const off = 1 + pulse * (1 + i * 4);
        filters.push(
          `drop-shadow(${off.toFixed(2)}px 0 0 rgba(242,58,94,0.6)) drop-shadow(${(-off).toFixed(2)}px 0 0 rgba(58,200,242,0.6))`,
        );
        break;
      }
      case 'scan-lines': {
        const b = 0.95 + Math.sin(t * 40) * 0.05 * i;
        filters.push(`brightness(${b.toFixed(3)})`);
        break;
      }
      case 'vortex': {
        const r = (t * 30 * i) % 360;
        const s = 1 + Math.sin(t * 2) * 0.05 * i;
        out.rotateRad += (r * Math.PI) / 180;
        out.scaleX *= s;
        out.scaleY *= s;
        break;
      }
      case 'wave-distort': {
        const sx = 1 + Math.sin(t * 4) * 0.04 * i;
        const sy = 1 + Math.cos(t * 4) * 0.04 * i;
        out.scaleX *= sx;
        out.scaleY *= sy;
        break;
      }
    }
  }

  out.filter = filters.join(' ');
  return out;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Parse a CSS transform string (the kind {@link computeMotionFx} and the transitions
 * preview produce) into translate/scale/rotate primitives we can compose on a canvas
 * context. Only the operations preview actually emits are supported.
 */
export function parseCssTransform(transform: string | undefined | null): {
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  rotateRad: number;
} {
  const out = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotateRad: 0 };
  if (!transform) return out;
  const re = /([a-zA-Z-]+)\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(transform)) !== null) {
    const [, fn, argsRaw] = match;
    const args = argsRaw.split(',').map((s) => s.trim());
    switch (fn) {
      case 'translate': {
        out.translateX += parseLen(args[0] ?? '0');
        out.translateY += parseLen(args[1] ?? '0');
        break;
      }
      case 'translateX':
        out.translateX += parseLen(args[0] ?? '0');
        break;
      case 'translateY':
        out.translateY += parseLen(args[0] ?? '0');
        break;
      case 'scale': {
        const sx = parseFloat(args[0] ?? '1');
        const sy = args[1] !== undefined ? parseFloat(args[1]) : sx;
        out.scaleX *= sx;
        out.scaleY *= sy;
        break;
      }
      case 'scaleX':
        out.scaleX *= parseFloat(args[0] ?? '1');
        break;
      case 'scaleY':
        out.scaleY *= parseFloat(args[0] ?? '1');
        break;
      case 'rotate':
      case 'rotateZ': {
        out.rotateRad += parseAngle(args[0] ?? '0');
        break;
      }
    }
  }
  return out;
}

function parseLen(s: string): number {
  // Strip 'px' suffix; treat '%' as 0 (preview uses %  for slide transitions, which we
  // handle separately in transitions-canvas.ts).
  if (s.endsWith('%')) return 0;
  return parseFloat(s.replace('px', '')) || 0;
}

function parseAngle(s: string): number {
  if (s.endsWith('rad')) return parseFloat(s) || 0;
  // Default to degrees.
  return ((parseFloat(s) || 0) * Math.PI) / 180;
}
