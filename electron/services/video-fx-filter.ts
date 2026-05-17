/**
 * Translate clip-level video motion FX into FFmpeg `-vf` / `-filter_complex` video filter
 * strings for export.
 *
 * The renderer stores motion FX inside a clip's `effects_json` array (see
 * `src/utils/motion-fx.ts`). At export time we want to bake a subset of those effects into
 * the rendered MP4. This helper returns one comma-joinable FFmpeg filter per effect, in the
 * same order they were applied.
 *
 * NOT YET WIRED — `filter-graph.ts` will call this and append the result to the per-clip
 * video filter chain. See the comment at the bottom of this file for the integration sketch.
 *
 * Type note: the renderer owns the canonical `MotionEffect` shape (`src/utils/motion-fx.ts`).
 * Because the Electron tsconfig doesn't include `src/`, we mirror a minimal structural type
 * here. The JSON wire format is the contract.
 *
 * Coverage:
 *   - Has an FFmpeg equivalent: vignette, blur, sharpen, pixelate, mirror-x, mirror-y,
 *     vhs, dream-glow, chromatic-strobe, scan-lines, vortex, wave-distort.
 *   - Preview-only (returned filters are empty / skipped): shake, zoom-pulse, ken-burns,
 *     float, jitter, spin-drift, rgb-shift, flash, kaleidoscope. These are time-varying
 *     transforms applied per-frame by the renderer; baking them into FFmpeg would require
 *     `geq` / sendcmd shenanigans, which a future pass can address by rendering the preview
 *     canvas straight to MP4 instead.
 */

export interface VideoEffect {
  type: string;
  intensity?: number;
}

/**
 * Map an array of video motion effects to FFmpeg video filter strings. Each returned string
 * is a single comma-joinable `-vf` token (some entries — notably `pixelate` — expand to two
 * back-to-back filters; we still return them as two separate strings so the caller can
 * inline them into its own comma-joined chain).
 *
 * Unknown / preview-only types are silently skipped.
 */
export function videoFxToFFmpegFilters(effects: VideoEffect[]): string[] {
  const out: string[] = [];
  for (const e of effects) {
    const i = clamp01(e.intensity ?? 0.5);
    appendFiltersForType(out, e.type, i);
  }
  return out;
}

function appendFiltersForType(out: string[], type: string, i: number): void {
  switch (type) {
    case 'vignette': {
      // Smaller angle = tighter, darker vignette. Maps i=0 → PI/4, i=1 → PI/2.5.
      const angle = (4 - i * 1.5).toFixed(2);
      out.push(`vignette=PI/${angle}`);
      return;
    }
    case 'blur': {
      const r = (i * 8).toFixed(1);
      out.push(`boxblur=${r}:${r}`);
      return;
    }
    case 'sharpen': {
      const amount = (i * 1.5).toFixed(2);
      out.push(`unsharp=5:5:${amount}:5:5:0`);
      return;
    }
    case 'pixelate': {
      // Down/up scale trick with nearest-neighbor for chunky blocks.
      const factor = Math.max(2, Math.round(20 - i * 16));
      out.push(`scale=iw/${factor}:ih/${factor}:flags=neighbor`);
      out.push(`scale=iw*${factor}:ih*${factor}:flags=neighbor`);
      return;
    }
    case 'mirror-x':
      out.push('hflip');
      return;
    case 'mirror-y':
      out.push('vflip');
      return;
    case 'vhs': {
      out.push('hue=s=0.80');
      out.push(`noise=alls=${(15 * i).toFixed(0)}:allf=t+u`);
      return;
    }
    case 'dream-glow': {
      out.push(`gblur=sigma=${(2 + i * 4).toFixed(2)}`);
      out.push(`eq=brightness=${(0.05 + i * 0.1).toFixed(3)}`);
      return;
    }
    case 'chromatic-strobe': {
      out.push(`hue=h=${(i * 30).toFixed(2)}`);
      return;
    }
    case 'scan-lines': {
      // No native scan-lines; approximate with contrast/brightness modulation.
      out.push(`eq=contrast=${(1 + i * 0.2).toFixed(2)}:brightness=${(-0.05 * i).toFixed(3)}`);
      return;
    }
    case 'vortex': {
      out.push(`rotate=${(i * 0.3).toFixed(3)}:c=black`);
      return;
    }
    case 'wave-distort': {
      // Static approximation — true sinusoidal warp requires `geq` per-frame.
      out.push(`eq=saturation=${(1 + i * 0.3).toFixed(2)}`);
      return;
    }
    // Preview-only / time-varying effects — intentionally skipped here.
    case 'shake':
    case 'zoom-pulse':
    case 'ken-burns':
    case 'float':
    case 'jitter':
    case 'spin-drift':
    case 'rgb-shift':
    case 'flash':
    case 'kaleidoscope':
      return;
    default:
      return;
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/*
 * INTEGRATION SKETCH (for filter-graph.ts, not yet wired):
 *
 *   import { videoFxToFFmpegFilters, type VideoEffect } from './video-fx-filter';
 *
 *   // After parsing clip.effects_json into `effects: VideoEffect[]`:
 *   const videoFx = videoFxToFFmpegFilters(effects);
 *   if (videoFx.length > 0) {
 *     // Append into this clip's per-clip filter chain BEFORE the final scale/concat step.
 *     clipFilterParts.push(...videoFx);
 *   }
 */
