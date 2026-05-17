/**
 * Canvas2D twin for transition visuals. The preview emits transforms in % units (slide,
 * push, etc.) because the DOM-laid-out clip box is the reference frame. Here we know the
 * canvas size, so we convert % offsets to pixel offsets in {@link applyTransitionToCtx}.
 *
 * Visual + computeTransitionStates from `@/utils/transitions` are reused as-is; this file
 * only converts the resulting CSS strings into canvas ops.
 */

import type { TransitionClipShape, TransitionVisual } from '@/utils/transitions';

export interface TransitionCanvasOps {
  /** Multiplier on alpha. */
  opacity: number;
  /** Translate in canvas pixels (already converted from %). */
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  rotateRad: number;
  /** ctx.filter-compatible string. */
  filter: string;
  /** Reveal mask for wipe/iris transitions — applied via `applyTransitionClip`. */
  clipShape?: TransitionClipShape;
}

const IDLE: TransitionCanvasOps = {
  opacity: 1,
  translateX: 0,
  translateY: 0,
  scaleX: 1,
  scaleY: 1,
  rotateRad: 0,
  filter: '',
};

/**
 * Apply a `TransitionClipShape` to the given context as a clipping region in **canvas
 * pixel space** (caller is expected to call this with the CTM at identity, before
 * applying per-clip transforms — the clip region is baked into pixel coords at the
 * moment of `clip()` and survives subsequent CTM changes).
 */
export function applyTransitionClip(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  shape: TransitionClipShape,
  W: number,
  H: number,
): void {
  ctx.beginPath();
  if (shape.kind === 'inset') {
    const top = (shape.topPct / 100) * H;
    const right = (shape.rightPct / 100) * W;
    const bottom = (shape.bottomPct / 100) * H;
    const left = (shape.leftPct / 100) * W;
    const w = Math.max(0, W - left - right);
    const h = Math.max(0, H - top - bottom);
    ctx.rect(left, top, w, h);
  } else {
    // CSS rule: 100% radius == sqrt(W² + H²) / sqrt(2). So 70.7% covers a rect box exactly.
    const refRadius = Math.sqrt(W * W + H * H) / Math.SQRT2;
    const radius = Math.max(0, (shape.radiusPct / 100) * refRadius);
    const cx = (shape.cxPct / 100) * W;
    const cy = (shape.cyPct / 100) * H;
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
  }
  ctx.clip();
}

/**
 * Convert a {@link TransitionVisual} (computed by `computeTransitionStates`) into canvas
 * primitives. `canvasW`/`canvasH` are needed because preview emits percentage offsets for
 * slide/push transitions — we resolve them to pixels here. `pxScale` is the preview→export
 * scale factor; it's applied to **raw px** translates (e.g. glitch's `translateX(6px)`)
 * which are calibrated to preview-pixel space. **Percentage** translates are already in
 * the right space because we resolved them against the export canvas dimensions.
 */
export function transitionVisualToCanvas(
  visual: TransitionVisual | undefined,
  canvasW: number,
  canvasH: number,
  pxScale: number = 1,
): TransitionCanvasOps {
  if (!visual) return { ...IDLE };
  const out: TransitionCanvasOps = {
    opacity: visual.opacity,
    translateX: 0,
    translateY: 0,
    scaleX: 1,
    scaleY: 1,
    rotateRad: 0,
    filter: visual.filter ?? '',
    clipShape: visual.clipShape,
  };

  // Parse the CSS-ish transform string. Allow % offsets — they become pixels in our space.
  const re = /([a-zA-Z-]+)\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(visual.transform || '')) !== null) {
    const [, fn, argsRaw] = match;
    const args = argsRaw.split(',').map((s) => s.trim());
    switch (fn) {
      case 'translate': {
        out.translateX += parseLenInPx(args[0] ?? '0', canvasW, pxScale);
        out.translateY += parseLenInPx(args[1] ?? '0', canvasH, pxScale);
        break;
      }
      case 'translateX':
        out.translateX += parseLenInPx(args[0] ?? '0', canvasW, pxScale);
        break;
      case 'translateY':
        out.translateY += parseLenInPx(args[0] ?? '0', canvasH, pxScale);
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
        const raw = args[0] ?? '0';
        const rad = raw.endsWith('rad')
          ? parseFloat(raw)
          : ((parseFloat(raw) || 0) * Math.PI) / 180;
        out.rotateRad += rad;
        break;
      }
    }
  }
  return out;
}

function parseLenInPx(s: string, dimensionPx: number, pxScale: number = 1): number {
  const trimmed = s.trim();
  if (trimmed.endsWith('%')) {
    // % values are proportional to the canvas — already in export-pixel space because we
    // resolved against the export canvas's width/height. Don't re-scale.
    const pct = parseFloat(trimmed) || 0;
    return (pct / 100) * dimensionPx;
  }
  // Raw px (e.g. `translateX(6px)` for glitch jitter) are calibrated to preview-pixel
  // space — scale into export-pixel space so a 6px jitter looks the same relative to the
  // canvas as it did in the editor.
  return (parseFloat(trimmed.replace('px', '')) || 0) * pxScale;
}
