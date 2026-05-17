import { memo, useMemo } from 'react';
import { useWaveform } from '@/hooks/useWaveform';

interface Props {
  assetId: string | null;
  width: number;
  height: number;
  muted?: boolean;
  /** Source-in / source-out for trimming the waveform window */
  sourceInMs: number;
  sourceOutMs: number;
  totalDurationMs: number;
}

function WaveformInner({ assetId, width, height, muted, sourceInMs, sourceOutMs, totalDurationMs }: Props): JSX.Element {
  const data = useWaveform(assetId);

  // Quantize the in/out points to ~50 ms buckets so micro-jitter during a trim drag
  // doesn't invalidate the memo. The user sees the same waveform unless they move
  // far enough for the result to actually differ at this resolution.
  const inQ = Math.round(sourceInMs / 50) * 50;
  const outQ = Math.round(sourceOutMs / 50) * 50;
  // Width also quantized — bucket to 8 px so per-frame width wiggle from the parent
  // clip's resize doesn't re-bucket. Visually indistinguishable.
  const widthQ = Math.max(20, Math.round(width / 8) * 8);

  const peaks = useMemo(() => {
    if (!data || !totalDurationMs) {
      const fallback = Math.max(20, Math.floor(widthQ / 4));
      return Array.from({ length: fallback }, (_, i) => {
        const t = i / fallback;
        return Math.max(0.1, Math.abs(Math.sin(t * 28) * 0.5 + Math.sin(t * 11) * 0.3));
      });
    }
    const startIdx = Math.floor((inQ / totalDurationMs) * data.length);
    const endIdx = Math.floor((outQ / totalDurationMs) * data.length);
    const slice = data.slice(startIdx, Math.max(startIdx + 1, endIdx));
    const buckets = Math.max(20, Math.floor(widthQ / 4));
    if (slice.length <= buckets) return slice;
    const out: number[] = [];
    const step = slice.length / buckets;
    for (let i = 0; i < buckets; i++) {
      let peak = 0;
      const start = Math.floor(i * step);
      const end = Math.min(slice.length, Math.floor((i + 1) * step));
      for (let j = start; j < end; j++) if (slice[j] > peak) peak = slice[j];
      out.push(peak);
    }
    return out;
  }, [data, widthQ, inQ, outQ, totalDurationMs]);

  // Render as one SVG <path> instead of N <rect>s. Cuts React reconciliation cost
  // by ~Nx — biggest win during continuous trim drags where this re-renders every
  // pointermove. Path uses M/L/Z per bar so the shape matches the old rects exactly.
  const d = useMemo(() => {
    const parts: string[] = [];
    for (let i = 0; i < peaks.length; i++) {
      const v = peaks[i];
      const x = i + 0.2;
      const y = 10 - v * 9;
      const h = Math.max(0.5, v * 18);
      parts.push(`M${x} ${y}h0.6v${h}h-0.6Z`);
    }
    return parts.join('');
  }, [peaks]);

  const N = peaks.length;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${N} 20`}
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        inset: '4px 0',
        opacity: muted ? 0.25 : 0.9,
        mixBlendMode: 'overlay',
      }}
    >
      <path d={d} fill="#0A0A0C" />
    </svg>
  );
}

export const Waveform = memo(WaveformInner);
