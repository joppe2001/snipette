import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import { useTimelineGeometry } from '@/hooks/useTimeline';
import { MARKER_COLORS, type Marker } from '@/utils/markers';
import type { ContextMenuItem } from '@/store/editor.store';

const FLAG_W = 12;
const FLAG_H = 14;

/**
 * Floating layer above the ruler that renders each marker as a small pentagon flag
 * with its label pinned below it. Click selects, double-click renames, right-click
 * opens a context menu. Lives at z-index 4 — below the playhead (5).
 */
export function MarkerLayer(): JSX.Element {
  const markers = useTimelineStore((s) => s.markers);
  const selectedMarkerIds = useTimelineStore((s) => s.selectedMarkerIds);
  const { timeToX } = useTimelineGeometry();

  const selectMarker = useTimelineStore((s) => s.selectMarker);
  const updateMarker = useTimelineStore((s) => s.updateMarker);
  const removeMarker = useTimelineStore((s) => s.removeMarker);
  const removeSelectedMarkers = useTimelineStore((s) => s.removeSelectedMarkers);
  const clearMarkers = useTimelineStore((s) => s.clearMarkers);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const setContextMenu = useEditorStore((s) => s.setContextMenu);

  const onRename = (m: Marker) => {
    const next = window.prompt('Marker label', m.label);
    if (next !== null) updateMarker(m.id, { label: next });
  };

  const openMenu = (e: React.MouseEvent, m: Marker) => {
    e.preventDefault();
    e.stopPropagation();
    const colorItems: ContextMenuItem[] = MARKER_COLORS.map((c) => ({
      kind: 'item' as const,
      label: c === m.color ? `${c}  •` : c,
      onClick: () => updateMarker(m.id, { color: c }),
    }));
    const selectionCount = selectedMarkerIds.length;
    const totalCount = markers.length;
    const items: ContextMenuItem[] = [
      { kind: 'header', label: m.label ? `Marker · ${m.label}` : 'Marker' },
      { label: 'Rename', onClick: () => onRename(m) },
      { label: 'Jump to start', onClick: () => setPlayhead(m.time_ms) },
      { kind: 'separator' },
      { kind: 'header', label: 'Change color' },
      ...colorItems,
      { kind: 'separator' },
      { label: 'Delete marker', danger: true, onClick: () => removeMarker(m.id) },
    ];
    if (selectionCount > 1 && selectedMarkerIds.includes(m.id)) {
      items.push({
        label: `Delete ${selectionCount} selected markers`,
        danger: true,
        onClick: () => removeSelectedMarkers(),
      });
    }
    if (totalCount > 1) {
      items.push({
        label: `Clear all markers (${totalCount})`,
        danger: true,
        onClick: () => clearMarkers(),
      });
    }
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 24,
        pointerEvents: 'none',
        zIndex: 4,
      }}
    >
      {markers.map((m) => {
        const x = timeToX(m.time_ms);
        const selected = selectedMarkerIds.includes(m.id);
        return (
          <div
            key={m.id}
            style={{
              position: 'absolute',
              left: x,
              top: 0,
              transform: 'translateX(-50%)',
              pointerEvents: 'auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
            onClick={(e) => {
              e.stopPropagation();
              // Shift or Cmd/Ctrl click toggles membership in the selection set.
              const multi = e.shiftKey || e.metaKey || e.ctrlKey;
              selectMarker(m.id, multi);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onRename(m);
            }}
            onContextMenu={(e) => openMenu(e, m)}
            title={m.label || 'Marker'}
          >
            {/* Pentagon flag: rectangle top + triangle bottom point. */}
            <svg
              width={FLAG_W}
              height={FLAG_H}
              viewBox={`0 0 ${FLAG_W} ${FLAG_H}`}
              style={{
                display: 'block',
                filter: selected ? `drop-shadow(0 0 4px ${m.color})` : undefined,
                cursor: 'pointer',
              }}
            >
              <polygon
                points={`0,0 ${FLAG_W},0 ${FLAG_W},${FLAG_H - 5} ${FLAG_W / 2},${FLAG_H} 0,${FLAG_H - 5}`}
                fill={m.color}
                stroke={selected ? '#fff' : 'rgba(0,0,0,0.5)'}
                strokeWidth={selected ? 1.5 : 1}
              />
            </svg>
            {m.label && (
              <span
                className="mono"
                style={{
                  marginTop: 2,
                  fontSize: 9,
                  lineHeight: 1,
                  padding: '2px 5px',
                  borderRadius: 3,
                  background: 'var(--bg-elevated)',
                  border: `1px solid ${selected ? m.color : 'var(--border-subtle)'}`,
                  color: 'var(--text-primary)',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  maxWidth: 120,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {m.label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
