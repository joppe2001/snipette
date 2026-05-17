/**
 * Helper for the export pipeline that converts a clip's keyframe tracks into FFmpeg
 * expression strings (suitable for `overlay=x=…:y=…`, `scale=…`, `rotate=…`, `format=...`
 * with alpha, etc.).
 *
 * EXPORT INTEGRATION: TODO — call from filter-graph.ts.
 * The export pipeline can use `keyframesToFFmpegExpression(tracks, clip.duration_ms)` to
 * pull per-channel `if(between(t,A,B), ...)` expressions and splice them into the filter
 * graph that builds each clip's video chain.
 *
 * NOTE: this file mirrors a minimal slice of the renderer's keyframes types because the
 * two sides use different tsconfigs and a cross-import isn't possible.
 */

interface Keyframe {
  t: number;
  v: number;
  easing?: string;
}

type KeyframeTracks = Record<string, Keyframe[]>;

export interface FFmpegKeyframeExpressions {
  /** Translate-X — for overlay=x=… */
  x?: string;
  /** Translate-Y — for overlay=y=… */
  y?: string;
  /** Uniform scale expression for `scale=` (we choose scale_x; non-uniform isn't supported by `scale=` directly). */
  scale?: string;
  /** Rotation in radians for `rotate=` (FFmpeg's rotate filter expects radians). */
  rotate?: string;
  /** Alpha multiplier for `format=…,colorchannelmixer=aa=` chains (0..1). */
  alpha?: string;
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Build a stepwise piecewise `if(between(t,A,B), linear_interp, ...else…)` expression that
 * approximates linear interpolation between adjacent keyframes. Times are in seconds (FFmpeg
 * exposes `t` to filter expressions as the timestamp in seconds).
 *
 * If the track has a single keyframe, returns a constant. If empty, returns null.
 */
function buildTrackExpr(
  keyframes: Keyframe[],
  durationMs: number,
  transform: (v: number) => number = (v) => v,
): string | null {
  if (!keyframes || keyframes.length === 0) return null;
  const sorted = keyframes.slice().sort((a, b) => a.t - b.t);
  if (sorted.length === 1) {
    return transform(sorted[0].v).toFixed(6);
  }

  // Compose nested if() expressions: if(between(t,t0,t1), v0+(v1-v0)*(t-t0)/(t1-t0), …next…).
  // For times before the first keyframe, hold v0; for times after the last, hold vN.
  const durationS = Math.max(0.001, durationMs / 1000);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  let expr = transform(last.v).toFixed(6); // fallback if past the last keyframe
  for (let i = sorted.length - 2; i >= 0; i--) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const aS = Math.max(0, a.t / 1000);
    const bS = Math.min(durationS, b.t / 1000);
    const span = Math.max(0.001, bS - aS);
    if (a.easing === 'hold') {
      expr = `if(between(t,${aS.toFixed(4)},${bS.toFixed(4)}),${transform(a.v).toFixed(6)},${expr})`;
    } else {
      const va = transform(a.v).toFixed(6);
      const vb = transform(b.v).toFixed(6);
      // linear: va + (vb-va) * (t - aS) / span
      const interp = `(${va}+(${vb}-${va})*(t-${aS.toFixed(4)})/${span.toFixed(4)})`;
      expr = `if(between(t,${aS.toFixed(4)},${bS.toFixed(4)}),${interp},${expr})`;
    }
  }
  // Times before the first keyframe hold v0.
  const firstS = Math.max(0, first.t / 1000);
  expr = `if(lt(t,${firstS.toFixed(4)}),${transform(first.v).toFixed(6)},${expr})`;
  return expr;
}

export function keyframesToFFmpegExpression(
  tracks: KeyframeTracks,
  durationMs: number,
): FFmpegKeyframeExpressions {
  const out: FFmpegKeyframeExpressions = {};

  const x = tracks.position_x;
  if (x && x.length > 0) {
    const expr = buildTrackExpr(x, durationMs);
    if (expr) out.x = expr;
  }
  const y = tracks.position_y;
  if (y && y.length > 0) {
    const expr = buildTrackExpr(y, durationMs);
    if (expr) out.y = expr;
  }

  // scale=… supports only one scalar; we pick scale_x. Non-uniform animated scale would need
  // a `scale=` + separate `setdar` or a `geq` workaround.
  const sx = tracks.scale_x;
  if (sx && sx.length > 0) {
    const expr = buildTrackExpr(sx, durationMs);
    if (expr) out.scale = expr;
  }

  const rot = tracks.rotation;
  if (rot && rot.length > 0) {
    const expr = buildTrackExpr(rot, durationMs, (v) => v * DEG_TO_RAD);
    if (expr) out.rotate = expr;
  }

  const op = tracks.opacity;
  if (op && op.length > 0) {
    const expr = buildTrackExpr(op, durationMs);
    if (expr) out.alpha = expr;
  }

  return out;
}
