import { memo, useMemo } from 'react';
import { useTimelineStore } from '@/store/timeline.store';
import { useTimelineGeometry } from '@/hooks/useTimeline';

const TICK_STEP_CANDIDATES = [100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000];
const TICK_TARGET_PX = 80;

function TimelineRulerInner({ widthPx }: { widthPx: number }): JSX.Element {
  const zoom = useTimelineStore((s) => s.zoomLevel);
  const activeTool = useTimelineStore((s) => s.activeTool);
  const zoomIn = useTimelineStore((s) => s.zoomIn);
  const zoomOut = useTimelineStore((s) => s.zoomOut);
  const { xToTime, timeToX } = useTimelineGeometry();
  const scroll = useTimelineStore((s) => s.scrollOffsetMs);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);

  // Decide tick spacing based on zoom: fall into 100ms / 500ms / 1s / 5s / 10s / 30s steps.
  // Memoized so we don't rebuild the (potentially hundreds-long) tick array on every
  // playhead tick or unrelated re-render.
  const ticks = useMemo(() => {
    const step = TICK_STEP_CANDIDATES.find((s) => (s / 1000) * zoom >= TICK_TARGET_PX) ?? 60_000;
    const startMs = scroll;
    const endMs = (widthPx / zoom) * 1000 + scroll;
    const out: { ms: number; major: boolean }[] = [];
    const minorStep = step / 5;
    for (let m = Math.floor(startMs / minorStep) * minorStep; m < endMs; m += minorStep) {
      out.push({ ms: m, major: m % step === 0 });
    }
    return out;
  }, [widthPx, zoom, scroll]);
  void xToTime;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 24,
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-subtle)',
        cursor:
          activeTool === 'hand' ? 'grab' : activeTool === 'zoom' ? 'zoom-in' : 'col-resize',
        userSelect: 'none',
      }}
      onPointerDown={(e) => {
        // Hand tool: let the parent scroll container handle the drag-pan; don't scrub.
        if (activeTool === 'hand') return;
        // Zoom tool: click to zoom in, alt-click to zoom out (still keep playhead untouched).
        if (activeTool === 'zoom') {
          if (e.altKey) zoomOut();
          else zoomIn();
          return;
        }
        const rect = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - rect.left;
        setPlayhead(Math.max(0, xToTime(px)));
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (activeTool === 'hand' || activeTool === 'zoom') return;
        if (e.buttons === 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        setPlayhead(Math.max(0, xToTime(e.clientX - rect.left)));
      }}
    >
      <svg width={widthPx} height={24} style={{ position: 'absolute', inset: 0 }}>
        {ticks.map((t, i) => {
          const x = timeToX(t.ms);
          return (
            <g key={i}>
              <line
                x1={x}
                x2={x}
                y1={t.major ? 8 : 16}
                y2={24}
                stroke={t.major ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)'}
                strokeWidth={1}
              />
              {t.major && (
                <text x={x + 4} y={11} fontFamily="JetBrains Mono, monospace" fontSize={9} fill="var(--text-muted)">
                  {formatLabel(t.ms)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function formatLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}

export const TimelineRuler = memo(TimelineRulerInner);
