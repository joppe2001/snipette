/**
 * Canvas2D text renderer — the export-time counterpart of {@link textStyleToCss}.
 *
 * The preview applies a `<span>` with CSS that bakes:
 *   - font, weight, italic, color
 *   - text-stroke (WebKit-only), shadow stack (text-shadow), 3D extrude (also as shadows)
 *   - gradient/rainbow fill via background-clip:text
 *   - bg box, padding, radius
 *
 * Canvas2D doesn't have most of those primitives natively. We rebuild them by painting
 * multiple passes:
 *   1. Layout: measure metrics, compute box.
 *   2. Background box (if enabled).
 *   3. Extrude stack (N offset copies of the fill).
 *   4. Shadow + glow: emulated by drawing the text multiple times with `ctx.shadowColor`.
 *   5. Stroke (outline).
 *   6. Fill — solid color, gradient, or rainbow.
 *
 * This produces output visually equivalent to the preview for the common templates and
 * all the new features the legacy `drawtext` export drops (gradients, emoji, custom
 * fonts, 3D extrude, glow falloff).
 */

import type { TextStyleFull } from '@/utils/text-templates';
import type { TextAnimationVisual } from '@/utils/text-animation';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface RenderTextOpts {
  ctx: Ctx;
  /** Center the text at this canvas-space point. */
  centerX: number;
  centerY: number;
  /** The string to draw (may already be typewriter-clipped). */
  text: string;
  style: Partial<TextStyleFull>;
  /** Animation visual; applies opacity + per-character extras. */
  visual: TextAnimationVisual;
  /** `playheadMs - clip.start_time_ms` — used for rainbow gradient phase. */
  relativeMs: number;
  /**
   * Max width (in current-CTM units) the text is allowed to occupy. When set, long
   * lines word-wrap and long unbreakable words break by character — mirrors what the
   * preview's `whiteSpace: pre-wrap; overflow-wrap: anywhere` CSS does. Omit for
   * "no wrapping" (legacy behavior).
   */
  maxWidth?: number;
}

const DEFAULT_FONT_FAMILY = "'Sora', system-ui, -apple-system, 'Helvetica Neue', sans-serif";

/** Quote a font family name if it contains spaces; pass through otherwise. */
function quoteFontFamily(family: string | undefined): string {
  if (!family) return DEFAULT_FONT_FAMILY;
  if (family.includes(',')) return family;
  const trimmed = family.trim();
  if (/\s/.test(trimmed) && !/^["']/.test(trimmed)) {
    return `"${trimmed}", ${DEFAULT_FONT_FAMILY}`;
  }
  return `${trimmed}, ${DEFAULT_FONT_FAMILY}`;
}

/**
 * Greedy word-wrap with character-level breaking for tokens longer than `maxWidth`.
 * Matches CSS `overflow-wrap: anywhere` behavior closely enough for export parity with
 * the preview. Caller must have already set `ctx.font` + `ctx.letterSpacing`.
 */
function wrapText(ctx: Ctx, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  const paragraphs = text.split('\n');
  for (const para of paragraphs) {
    if (!para) {
      out.push('');
      continue;
    }
    const words = para.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= maxWidth) {
        line = test;
        continue;
      }
      if (line) out.push(line);
      // Long word — break by character so it still fits.
      if (ctx.measureText(word).width > maxWidth) {
        let chunk = '';
        for (const ch of word) {
          const tentative = chunk + ch;
          if (chunk && ctx.measureText(tentative).width > maxWidth) {
            out.push(chunk);
            chunk = ch;
          } else {
            chunk = tentative;
          }
        }
        line = chunk;
      } else {
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out.length > 0 ? out : [''];
}

/**
 * Predict how tall a text block will render at given style + wrap width, in
 * the same coordinate space `renderTextClip` paints into. Used by the
 * compositor to stack compound title + subtitle rows without overlap — we
 * can't rely on `renderTextClip` returning the rendered metrics, and the
 * editor preview gets stacking "for free" via CSS flexbox.
 *
 * Returns `{ lines, height }` where `height = lines * line_height * font_size`.
 */
export function measureTextBlock(
  ctx: Ctx,
  text: string,
  style: Partial<TextStyleFull>,
  maxWidth: number,
): { lines: number; height: number; lineHeight: number } {
  const fontSize = style.font_size ?? 32;
  const fontWeight = style.font_weight ?? 700;
  const fontStyle = style.italic ? 'italic' : 'normal';
  ctx.save();
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${quoteFontFamily(style.font_family)}`;
  try {
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${style.letter_spacing ?? 0.02}em`;
  } catch {
    // letterSpacing not supported — measurement falls back to natural advance.
  }
  const transformed = applyTextTransform(text, style.text_transform);
  const lines = maxWidth > 0 ? wrapText(ctx, transformed, maxWidth) : transformed.split('\n');
  ctx.restore();
  const lineHeight = (style.line_height ?? 1.05) * fontSize;
  return { lines: lines.length, height: lines.length * lineHeight, lineHeight };
}

function applyTextTransform(text: string, transform: TextStyleFull['text_transform']): string {
  switch (transform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return text.replace(/\b\w/g, (c) => c.toUpperCase());
    case 'none':
    default:
      return text;
  }
}

export function renderTextClip(opts: RenderTextOpts): void {
  const { ctx, centerX, centerY, style, visual, relativeMs } = opts;
  const text = applyTextTransform(opts.text, style.text_transform);
  if (!text) return;

  const fontSize = style.font_size ?? 32;
  const fontWeight = style.font_weight ?? 700;
  const fontStyle = style.italic ? 'italic' : 'normal';
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${quoteFontFamily(style.font_family)}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lineHeight = (style.line_height ?? 1.05) * fontSize;

  // Letter-spacing — Canvas2D added `letterSpacing` recently. Fall back gracefully.
  // Set this BEFORE measuring so the wrap math reflects the same spacing.
  const letterSpacingEm = style.letter_spacing ?? 0.02;
  try {
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${letterSpacingEm}em`;
  } catch {
    // older runtimes ignore the assignment; spacing will be the font's natural advance.
  }

  // If a wrap width was given, greedily word-wrap, breaking long unbreakable tokens
  // by character. Otherwise just honor explicit newlines.
  const lines = opts.maxWidth && opts.maxWidth > 0
    ? wrapText(ctx, text, opts.maxWidth)
    : text.split('\n');

  // Compute metric box (width = longest line's measured width + padding).
  let maxLineWidth = 0;
  for (const line of lines) {
    const m = ctx.measureText(line);
    if (m.width > maxLineWidth) maxLineWidth = m.width;
  }
  const totalHeight = lineHeight * lines.length;
  const padding = style.bg_enabled ? style.bg_padding ?? 8 : 0;

  ctx.save();
  ctx.globalAlpha *= Math.max(0, Math.min(1, visual.opacity));

  // ---- BG BOX ----
  if (style.bg_enabled) {
    const boxW = maxLineWidth + padding * 2;
    const boxH = totalHeight + padding * 2;
    const radius = Math.min(style.bg_radius ?? 0, Math.min(boxW, boxH) / 2);
    ctx.fillStyle = style.bg_color ?? '#0A0A0C';
    drawRoundedRect(ctx, centerX - boxW / 2, centerY - boxH / 2, boxW, boxH, radius);
    ctx.fill();
  }

  // ---- TEXT PAINT PASSES ----
  // Draw each line at its baseline y.
  const startY = centerY - totalHeight / 2 + lineHeight / 2;

  // Resolve fill: gradient/rainbow take precedence over solid color.
  const fillStyle = resolveFill(ctx, style, maxLineWidth, totalHeight, centerX, centerY, relativeMs);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const y = startY + i * lineHeight;

    // 3D extrude — N offset copies of the fill behind the text.
    if (style.extrude_enabled) {
      const depth = Math.max(1, Math.min(40, style.extrude_depth ?? 6));
      const color = style.extrude_color ?? '#0A0A0C';
      ctx.fillStyle = color;
      for (let d = depth; d >= 1; d--) {
        ctx.fillText(line, centerX + d, y + d);
      }
    }

    // Glow + shadow — emulated via ctx.shadow*. We paint up to 3 stacked passes for the
    // halo falloff that matches the preview's three-layer text-shadow stack.
    if (style.glow_enabled) {
      const size = style.glow_size ?? 12;
      const color = style.glow_color ?? '#C8F23A';
      for (const m of [1, 2, 3]) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = size * m;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = 'rgba(0,0,0,0)';
        // Draw an invisible fill — shadow still renders. This is the standard canvas
        // trick for stand-alone glow without darkening the fill below.
        ctx.fillStyle = color;
        ctx.fillText(line, centerX, y);
        ctx.restore();
      }
    }
    if (style.shadow_enabled) {
      ctx.save();
      ctx.shadowColor = style.shadow_color ?? '#0A0A0C';
      ctx.shadowBlur = style.shadow_blur ?? 0;
      ctx.shadowOffsetX = style.shadow_x ?? 0;
      ctx.shadowOffsetY = style.shadow_y ?? 4;
      // Drawing a transparent fill still emits the shadow.
      ctx.fillStyle = fillStyle;
      ctx.fillText(line, centerX, y);
      ctx.restore();
    }

    // Stroke (text outline).
    if ((style.stroke_width ?? 0) > 0) {
      ctx.lineWidth = (style.stroke_width ?? 0) * 2; // canvas strokes outward in BOTH dirs; double matches WebKit's -webkit-text-stroke
      ctx.strokeStyle = style.stroke_color ?? '#0A0A0C';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeText(line, centerX, y);
    }

    // Final fill.
    ctx.fillStyle = fillStyle;
    ctx.fillText(line, centerX, y);
  }

  ctx.restore();
}

function drawRoundedRect(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  if (typeof (ctx as unknown as { roundRect?: unknown }).roundRect === 'function') {
    (ctx as CanvasRenderingContext2D).roundRect(x, y, w, h, r);
    return;
  }
  // Manual fallback for older runtimes.
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

const RAINBOW_STOPS: string[] = [
  '#f23a5e',
  '#f2a83a',
  '#ffe03a',
  '#3af26e',
  '#3ac8f2',
  '#9c3af2',
  '#f23ac8',
  '#f23a5e',
];

function resolveFill(
  ctx: Ctx,
  style: Partial<TextStyleFull>,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  relativeMs: number,
): string | CanvasGradient {
  if (style.rainbow_enabled) {
    // Animate the gradient phase to match the preview's `sn-text-rainbow 4s linear` anim.
    const periodMs = 4000;
    const phase = (relativeMs % periodMs) / periodMs;
    // Build a horizontal gradient that cycles through RAINBOW_STOPS, offset by `phase`.
    const grad = ctx.createLinearGradient(centerX - width / 2, centerY, centerX + width / 2, centerY);
    for (let i = 0; i < RAINBOW_STOPS.length; i++) {
      const stop = (i / (RAINBOW_STOPS.length - 1) - phase + 1) % 1;
      grad.addColorStop(stop, RAINBOW_STOPS[i]);
    }
    return grad;
  }
  if (style.gradient_enabled && style.gradient_from && style.gradient_to) {
    const angle = ((style.gradient_angle ?? 180) * Math.PI) / 180;
    // Compute gradient endpoints by projecting the text box onto the angle vector.
    const half = Math.max(width, height) / 2;
    const dx = Math.sin(angle) * half;
    const dy = -Math.cos(angle) * half;
    const grad = ctx.createLinearGradient(centerX - dx, centerY - dy, centerX + dx, centerY + dy);
    grad.addColorStop(0, style.gradient_from);
    grad.addColorStop(1, style.gradient_to);
    return grad;
  }
  return style.color ?? '#FFFFFF';
}
