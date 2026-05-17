import { useRef } from 'react';
import { useTimelineGeometry } from '@/hooks/useTimeline';
import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import type { Clip, Transition } from '@shared/types';

const TYPE_COLORS: Record<string, string> = {
  cut: '#9C3AF2',
  dissolve: '#C8F23A',
  fade: '#C8F23A',
  zoom: '#F2A83A',
  slide: '#3AC8F2',
  glitch: '#F23AC8',
  bounce: '#F2A83A',
  spin: '#9C3AF2',
  whip: '#F23A5E',
};

interface Props {
  transition: Transition;
  clipA: Clip;
  clipB: Clip;
}

/**
 * Diagonal-striped overlap block straddling the boundary between two clips on the same track.
 * Click to select. Right-click for a context menu (change duration / type / delete).
 */
export function TransitionMarker({ transition, clipA, clipB }: Props): JSX.Element | null {
  const { timeToX } = useTimelineGeometry();
  const zoom = useTimelineStore((s) => s.zoomLevel);
  const removeTransitionLocal = useTimelineStore((s) => s.removeTransitionLocal);
  const updateTransitionLocal = useTimelineStore((s) => s.updateTransitionLocal);
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const selectTransition = useTimelineStore((s) => s.selectTransition);
  const selected = useTimelineStore((s) => s.selectedTransitionId === transition.id);
  const setContextMenu = useEditorStore((s) => s.setContextMenu);
  const pushToast = useEditorStore((s) => s.pushToast);

  // Drag-to-resize state. We expand the transition window symmetrically around
  // its center (the boundary between the two clips) — the duration grows by 2×
  // the side handle's pixel-displacement so one-side drag widens both ends
  // equally. Mirrors what Premiere / Resolve do.
  const dragRef = useRef<{
    startX: number;
    origDuration: number;
    side: 'left' | 'right';
  } | null>(null);

  const persistDuration = async (nextDuration: number) => {
    // Round to nearest 10ms to keep things tidy. Clamp to a sane band.
    const clamped = Math.max(80, Math.min(5000, Math.round(nextDuration / 10) * 10));
    if (clamped === transition.duration_ms) return;
    pushHistory();
    updateTransitionLocal(transition.id, { duration_ms: clamped });
    try {
      await window.snipette.timeline.updateTransition(transition.id, { duration_ms: clamped });
    } catch {
      // Roll back optimistic update on failure.
      updateTransitionLocal(transition.id, { duration_ms: transition.duration_ms });
    }
  };

  const onHandlePointerDown = (side: 'left' | 'right') => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      origDuration: transition.duration_ms,
      side,
    };
  };

  const onHandlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dxPx = e.clientX - d.startX;
    const dxMs = (dxPx / zoom) * 1000;
    // Left handle dragging LEFT lengthens; right handle dragging RIGHT lengthens.
    // Both sides grow symmetrically so we apply 2× to the directional component.
    const delta = d.side === 'left' ? -dxMs * 2 : dxMs * 2;
    const next = Math.max(80, Math.min(5000, d.origDuration + delta));
    // Optimistic local update on every move — store mutation is cheap.
    updateTransitionLocal(transition.id, { duration_ms: next });
  };

  const onHandlePointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    dragRef.current = null;
    // Persist via IPC after the drag settles.
    void persistDuration(transition.duration_ms);
  };

  if (!clipA || !clipB) return null;
  const earlier = clipA.start_time_ms <= clipB.start_time_ms ? clipA : clipB;
  const later = earlier === clipA ? clipB : clipA;
  const boundaryMs = earlier.start_time_ms + earlier.duration_ms;
  const half = transition.duration_ms / 2;
  const startMs = Math.max(0, boundaryMs - half);
  const endMs = Math.max(startMs + 1, boundaryMs + half);
  const x = timeToX(startMs);
  const w = Math.max(8, ((endMs - startMs) / 1000) * zoom);

  const color = TYPE_COLORS[transition.type] ?? 'var(--accent-primary)';

  const remove = async () => {
    pushHistory();
    await window.snipette.timeline.deleteTransition(transition.id);
    removeTransitionLocal(transition.id);
    pushToast({ kind: 'success', message: 'Transition removed.' });
  };

  void later;

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        selectTransition(transition.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // Duration presets. TODO: enable once window.snipette.timeline.updateTransition lands —
        // the preload bridge currently only exposes add + delete, so mark these disabled so
        // the user can still see the intent without us inventing a missing IPC handler.
        const durationPresets: Array<{ label: string; ms: number }> = [
          { label: '0.25s', ms: 250 },
          { label: '0.5s', ms: 500 },
          { label: '1.0s', ms: 1000 },
          { label: '2.0s', ms: 2000 },
        ];
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            { kind: 'header', label: `${transition.type} · ${(transition.duration_ms / 1000).toFixed(2)}s` },
            { kind: 'separator' },
            { kind: 'header', label: 'Set duration' },
            ...durationPresets.map((p) => ({
              kind: 'item' as const,
              label: transition.duration_ms === p.ms ? `${p.label}  •` : p.label,
              onClick: () => void persistDuration(p.ms),
            })),
            { kind: 'separator' },
            { label: 'Delete transition', danger: true, onClick: () => remove() },
          ],
        });
      }}
      title={`${transition.type} · ${(transition.duration_ms / 1000).toFixed(2)}s — right-click to remove`}
      style={{
        position: 'absolute',
        top: 6,
        bottom: 6,
        left: x,
        width: w,
        borderRadius: 4,
        background: `repeating-linear-gradient(45deg, ${color} 0 6px, rgba(0,0,0,0.4) 6px 12px)`,
        border: `${selected ? 2 : 1}px solid ${selected ? '#fff' : color}`,
        boxShadow: selected
          ? `0 0 0 1.5px ${color}, 0 0 16px ${color}aa`
          : `0 0 8px ${color}55`,
        cursor: 'pointer',
        zIndex: 4,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span
        className="display"
        style={{
          fontSize: 8.5,
          letterSpacing: 0.6,
          color: '#0A0A0C',
          background: color,
          padding: '1px 4px',
          borderRadius: 2,
          textTransform: 'uppercase',
        }}
      >
        {transition.type}
      </span>
      {/* Left + right drag handles — widen/narrow the transition duration by
          pulling either edge. The transition stays centered on the cut so
          dragging either side grows the duration on BOTH ends. ew-resize
          cursor makes the affordance obvious. */}
      {(['left', 'right'] as const).map((side) => (
        <div
          key={side}
          onPointerDown={onHandlePointerDown(side)}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            [side]: 0,
            width: 6,
            cursor: 'ew-resize',
            background: selected
              ? 'rgba(255,255,255,0.35)'
              : 'rgba(255,255,255,0.12)',
            transition: 'background .12s ease',
            zIndex: 1,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.45)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = selected
              ? 'rgba(255,255,255,0.35)'
              : 'rgba(255,255,255,0.12)';
          }}
        />
      ))}
    </div>
  );
}

/**
 * Tiny "+" gap marker between two adjacent clips on the same track. Clicking it adds a
 * 500 ms fade transition (the cheapest default). Only shown when there's no existing
 * transition for that pair.
 */
export function TransitionGapAdd({
  clipA,
  clipB,
  trackId,
  projectId,
}: {
  clipA: Clip;
  clipB: Clip;
  trackId: string;
  projectId: string;
}): JSX.Element | null {
  const { timeToX } = useTimelineGeometry();
  const openTransitionPicker = useEditorStore((s) => s.openTransitionPicker);

  const earlier = clipA.start_time_ms <= clipB.start_time_ms ? clipA : clipB;
  const later = earlier === clipA ? clipB : clipA;
  const boundaryMs = earlier.start_time_ms + earlier.duration_ms;
  // Only show when the clips touch or overlap by less than ~50ms.
  const gap = later.start_time_ms - boundaryMs;
  if (gap > 60) return null;

  const onAdd = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Anchor the popover just below the "+" button.
    const rect = e.currentTarget.getBoundingClientRect();
    openTransitionPicker({
      x: rect.left + rect.width / 2 - 160, // half of POPOVER_W
      y: rect.bottom + 8,
      projectId,
      trackId,
      clipAId: earlier.id,
      clipBId: later.id,
    });
  };

  return (
    <button
      onClick={onAdd}
      title="Browse transitions…"
      style={{
        position: 'absolute',
        top: '50%',
        left: timeToX(boundaryMs),
        transform: 'translate(-50%, -50%)',
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--accent-primary)',
        color: 'var(--accent-primary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 700,
        lineHeight: 1,
        opacity: 0.35,
        transition: 'opacity .12s, transform .12s',
        zIndex: 3,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = '1';
        e.currentTarget.style.transform = 'translate(-50%, -50%) scale(1.15)';
      }}
      onFocus={(e) => (e.currentTarget.style.opacity = '1')}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = '0.35';
        e.currentTarget.style.transform = 'translate(-50%, -50%) scale(1)';
      }}
      onBlur={(e) => (e.currentTarget.style.opacity = '0.35')}
      data-sn-transition-gap
    >
      +
    </button>
  );
}
