import { memo } from 'react';
import { useTimelineStore } from '@/store/timeline.store';
import { useTimelineGeometry } from '@/hooks/useTimeline';
import { formatTime } from '@/utils/time';

function PlayheadInner({ height }: { height: number }): JSX.Element {
  const playhead = useTimelineStore((s) => s.playheadMs);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const { timeToX, xToTime } = useTimelineGeometry();
  const x = timeToX(playhead);

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: 0,
        bottom: 0,
        width: 2,
        background: 'var(--accent-primary)',
        boxShadow: '0 0 12px rgba(200,242,58,0.5)',
        zIndex: 5,
        pointerEvents: 'none',
        height,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 0,
          height: 0,
          borderLeft: '7px solid transparent',
          borderRight: '7px solid transparent',
          borderTop: '9px solid var(--accent-primary)',
          pointerEvents: 'auto',
          cursor: 'ew-resize',
        }}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          e.stopPropagation();
        }}
        onPointerMove={(e) => {
          if (e.buttons === 0) return;
          // Use the parent timeline-body as reference. We use clientX → time directly.
          const rect = (e.currentTarget.closest('.sn-timeline-body') as HTMLDivElement | null)?.getBoundingClientRect();
          const offsetX = rect ? e.clientX - rect.left : e.clientX;
          setPlayhead(Math.max(0, xToTime(offsetX)));
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: -22,
          left: 4,
          fontSize: 9,
          color: 'var(--accent-primary)',
          fontFamily: 'var(--font-mono)',
          whiteSpace: 'nowrap',
          background: '#0A0A0C',
          padding: '1px 4px',
          borderRadius: 2,
          border: '1px solid var(--accent-primary)',
        }}
      >
        {formatTime(playhead, true)}
      </div>
    </div>
  );
}

/** Memoized — `height` is the only prop and changes only when track count changes,
 *  so cascading parent re-renders (e.g. a sibling track row mutation) no longer drag
 *  Playhead's render along with them. */
export const Playhead = memo(PlayheadInner);
