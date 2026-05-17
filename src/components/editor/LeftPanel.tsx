import { useState } from 'react';
import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import { useProjectStore } from '@/store/project.store';
import { Icons } from '@/components/ui/icons';
import { MediaLibrary } from './MediaLibrary';
import type { ContextMenuItem } from '@/store/editor.store';
import type { Track, Clip, TrackKind } from '@shared/types';

const TOOLS: { tool: 'select' | 'razor' | 'text' | 'sticker' | 'hand' | 'zoom'; key: string; label: string; Icon: typeof Icons.Cursor }[] = [
  { tool: 'select', key: 'V', label: 'Select', Icon: Icons.Cursor },
  { tool: 'razor', key: 'B', label: 'Split clip at click', Icon: Icons.Razor },
  { tool: 'text', key: 'T', label: 'Add text', Icon: Icons.TextT },
  { tool: 'sticker', key: 'S', label: 'Drop a sticker', Icon: Icons.Star },
  { tool: 'hand', key: 'H', label: 'Pan the timeline', Icon: Icons.Hand },
  { tool: 'zoom', key: 'Z', label: 'Zoom · Alt-click to zoom out', Icon: Icons.Zoom },
];

export function LeftPanel(): JSX.Element {
  const activeTool = useTimelineStore((s) => s.activeTool);
  const setActiveTool = useTimelineStore((s) => s.setActiveTool);
  const tab = useEditorStore((s) => s.leftPanelTab);
  const setTab = useEditorStore((s) => s.setLeftPanelTab);
  const proxyProgress = useEditorStore((s) => s.proxyProgress);

  return (
    <div
      style={{
        borderRight: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ padding: '10px 10px 8px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
        {TOOLS.map((t) => {
          const on = activeTool === t.tool;
          return (
            <button
              key={t.tool}
              onClick={() => setActiveTool(t.tool)}
              title={`${t.label} · ${t.key}`}
              style={{
                aspectRatio: '1',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                borderRadius: 6,
                background: on ? 'rgba(200,242,58,0.10)' : 'transparent',
                color: on ? 'var(--accent-primary)' : 'var(--text-secondary)',
                boxShadow: on ? 'inset 0 -2px 0 var(--accent-primary)' : undefined,
                transition: 'background .12s, color .12s, box-shadow .12s',
              }}
              onMouseEnter={(e) => {
                if (!on) {
                  e.currentTarget.style.background = 'var(--bg-hover)';
                  e.currentTarget.style.color = 'var(--text-primary)';
                }
              }}
              onMouseLeave={(e) => {
                if (!on) {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'var(--text-secondary)';
                }
              }}
            >
              <t.Icon size={16} />
              <span
                style={{
                  position: 'absolute',
                  bottom: 3,
                  right: 4,
                  fontSize: 8.5,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                  color: on ? 'var(--accent-primary)' : 'var(--text-muted)',
                }}
              >
                {t.key}
              </span>
            </button>
          );
        })}
      </div>

      <div className="sn-divider" style={{ margin: '4px 12px' }} />

      <div style={{ padding: '8px 10px 6px', display: 'flex', gap: 4 }}>
        {(['library', 'layers'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              padding: '5px 0',
              fontSize: 10.5,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              borderRadius: 4,
              color: tab === t ? 'var(--accent-primary)' : 'var(--text-secondary)',
              background: tab === t ? 'rgba(200,242,58,0.08)' : 'transparent',
              transition: 'color .12s, background .12s',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'library' ? <MediaLibrary proxyProgress={proxyProgress} /> : <LayersPane />}

      <div
        style={{
          padding: 10,
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 10,
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Icons.Lock size={11} />
        <span>Local only · no cloud</span>
      </div>
    </div>
  );
}

function LayersPane(): JSX.Element {
  const tracks = useTimelineStore((s) => s.tracks);
  const clips = useTimelineStore((s) => s.clips);
  const upsertTrack = useTimelineStore((s) => s.upsertTrack);
  const removeTrack = useTimelineStore((s) => s.removeTrack);
  const reorderTracksLocal = useTimelineStore((s) => s.reorderTracksLocal);
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const project = useProjectStore((s) => s.activeProject);
  const pushToast = useEditorStore((s) => s.pushToast);
  const setContextMenu = useEditorStore((s) => s.setContextMenu);
  const [addMenu, setAddMenu] = useState(false);
  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
  const [dropAtIndex, setDropAtIndex] = useState<number | null>(null);

  const layers = clips.slice().sort((a, b) => a.start_time_ms - b.start_time_ms);

  /**
   * Insert a freshly created track at a specific index in the order. addTrack always
   * appends, so we reorder right after to put it where the user asked. Falls back to
   * appended order if reorder fails.
   */
  const addTrackAt = async (kind: TrackKind, insertIndex: number) => {
    if (!project) return;
    pushHistory();
    const created = await window.snipette.timeline.addTrack({ project_id: project.id, type: kind });
    useTimelineStore.getState().upsertTrack(created);
    // Build a new order: current ordered tracks with the freshly-created id slotted in.
    const ordered = [...useTimelineStore.getState().tracks]
      .filter((t) => t.id !== created.id)
      .sort((a, b) => a.order_index - b.order_index)
      .map((t) => t.id);
    const clamped = Math.max(0, Math.min(insertIndex, ordered.length));
    ordered.splice(clamped, 0, created.id);
    reorderTracksLocal(ordered);
    try {
      await window.snipette.timeline.reorderTracks(ordered);
    } catch (e) {
      pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Reorder failed.' });
    }
  };

  const openTrackMenu = (e: React.MouseEvent, track: Track, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const trackClipIds = clips.filter((c) => c.track_id === track.id).map((c) => c.id);
    const items: ContextMenuItem[] = [
      { kind: 'header', label: `${track.type} · ${track.name}` },
      {
        label: 'Rename track…',
        onClick: async () => {
          const next = window.prompt('Track name', track.name);
          if (next == null) return;
          const trimmed = next.trim();
          if (!trimmed || trimmed === track.name) return;
          pushHistory();
          try {
            const updated = await window.snipette.timeline.updateTrack(track.id, { name: trimmed });
            upsertTrack(updated);
          } catch (err) {
            pushToast({ kind: 'error', message: err instanceof Error ? err.message : 'Rename failed.' });
          }
        },
      },
      {
        label: track.is_muted ? 'Unmute' : 'Mute',
        onClick: async () => {
          const nextMuted = track.is_muted ? 0 : 1;
          upsertTrack({ ...track, is_muted: nextMuted });
          try {
            await window.snipette.timeline.updateTrack(track.id, { is_muted: nextMuted });
          } catch {
            // local already updated; non-fatal
          }
        },
      },
      {
        label: track.is_locked ? 'Unlock' : 'Lock',
        onClick: async () => {
          const nextLocked = track.is_locked ? 0 : 1;
          upsertTrack({ ...track, is_locked: nextLocked });
          try {
            await window.snipette.timeline.updateTrack(track.id, { is_locked: nextLocked });
          } catch {
            // local already updated; non-fatal
          }
        },
      },
      {
        label: track.is_visible ? 'Hide' : 'Show',
        onClick: async () => {
          const nextVisible = track.is_visible ? 0 : 1;
          upsertTrack({ ...track, is_visible: nextVisible });
          try {
            await window.snipette.timeline.updateTrack(track.id, { is_visible: nextVisible });
          } catch {
            // local already updated; non-fatal
          }
        },
      },
      { kind: 'separator' },
      {
        label: 'Add track above',
        onClick: () => void addTrackAt(track.type, idx),
      },
      {
        label: 'Add track below',
        onClick: () => void addTrackAt(track.type, idx + 1),
      },
      { kind: 'separator' },
      {
        label: `Select all clips on this track${trackClipIds.length ? ` (${trackClipIds.length})` : ''}`,
        disabled: trackClipIds.length === 0,
        onClick: () => {
          // Mirror selectAll() shape — clear other selections, set selectedClipIds.
          useTimelineStore.setState({
            selectedClipIds: trackClipIds,
            selectedTrackId: null,
            selectedTransitionId: null,
            selectedMarkerIds: [],
          });
        },
      },
      { kind: 'separator' },
      {
        label: 'Delete track',
        danger: true,
        onClick: async () => {
          if (!window.confirm(`Delete "${track.name}" and all its clips? This can be undone.`)) return;
          pushHistory();
          try {
            await window.snipette.timeline.deleteTrack(track.id);
            removeTrack(track.id);
            pushToast({ kind: 'success', message: 'Track deleted.' });
          } catch (err) {
            pushToast({ kind: 'error', message: err instanceof Error ? err.message : 'Delete failed.' });
          }
        },
      },
    ];
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const commitReorder = async (fromId: string, toIndex: number) => {
    const current = [...tracks].sort((a, b) => a.order_index - b.order_index);
    const fromIndex = current.findIndex((t) => t.id === fromId);
    if (fromIndex < 0) return;
    // toIndex is "insert-before-this-index"; adjust if we're moving forward.
    let target = toIndex;
    if (fromIndex < toIndex) target = toIndex - 1;
    if (target === fromIndex) return;
    const next = current.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(target, 0, moved);
    const orderedIds = next.map((t) => t.id);
    pushHistory();
    reorderTracksLocal(orderedIds);
    try {
      await window.snipette.timeline.reorderTracks(orderedIds);
    } catch (e) {
      pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Reorder failed.' });
    }
  };

  const addTrackOfKind = async (kind: TrackKind) => {
    if (!project) return;
    setAddMenu(false);
    const created = await window.snipette.timeline.addTrack({ project_id: project.id, type: kind });
    useTimelineStore.getState().upsertTrack(created);
    pushToast({ kind: 'success', message: `Added ${kind} track.` });
  };

  return (
    <>
      <div style={{ padding: '8px 12px 6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="sn-section-label">Layers</span>
          <span className="sn-pill" style={{ padding: '1px 6px', fontSize: 9.5 }}>{layers.length || tracks.length}</span>
        </div>
        <button
          className="sn-icon-btn"
          style={{ width: 22, height: 22 }}
          title="Add a new track"
          onClick={() => setAddMenu((o) => !o)}
        >
          <Icons.PlusSm size={12} />
        </button>
        {addMenu && (
          <div
            onMouseLeave={() => setAddMenu(false)}
            style={{
              position: 'absolute',
              right: 8,
              top: '100%',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              padding: 4,
              minWidth: 160,
              zIndex: 50,
              boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
            }}
          >
            {(['video', 'audio', 'text', 'sticker'] as TrackKind[]).map((kind) => (
              <button
                key={kind}
                onClick={() => addTrackOfKind(kind)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '7px 10px',
                  fontSize: 11.5,
                  borderRadius: 4,
                  color: 'var(--text-primary)',
                  background: 'transparent',
                  textTransform: 'capitalize',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                Add {kind} track
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        style={{ overflow: 'auto', flex: 1, padding: '0 6px 8px', position: 'relative' }}
        onDragLeave={(e) => {
          // Only clear when leaving the container entirely.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAtIndex(null);
        }}
      >
        {tracks.map((t, idx) => (
          <TrackHeaderRow
            key={t.id}
            track={t}
            clipsCount={clips.filter((c) => c.track_id === t.id).length}
            isDragging={draggingTrackId === t.id}
            showDropIndicatorAbove={dropAtIndex === idx}
            showDropIndicatorBelow={dropAtIndex === idx + 1 && idx === tracks.length - 1}
            onContextMenu={(e) => openTrackMenu(e, t, idx)}
            onDragStart={() => setDraggingTrackId(t.id)}
            onDragEnd={() => {
              setDraggingTrackId(null);
              setDropAtIndex(null);
            }}
            onDragOverRow={(beforeRow) => {
              setDropAtIndex(beforeRow ? idx : idx + 1);
            }}
            onDropOnRow={(beforeRow) => {
              const target = beforeRow ? idx : idx + 1;
              const dragId = draggingTrackId;
              setDraggingTrackId(null);
              setDropAtIndex(null);
              if (dragId) void commitReorder(dragId, target);
            }}
            onToggleVisible={() => upsertTrack({ ...t, is_visible: t.is_visible ? 0 : 1 })}
            onToggleLock={() => upsertTrack({ ...t, is_locked: t.is_locked ? 0 : 1 })}
            onDelete={async () => {
              if (!confirm(`Delete "${t.name}" and all its clips? This can be undone.`)) return;
              useTimelineStore.getState().pushHistory();
              await window.snipette.timeline.deleteTrack(t.id);
              removeTrack(t.id);
              pushToast({ kind: 'success', message: 'Track deleted.' });
            }}
          />
        ))}
        {clips.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 9.5, color: 'var(--text-muted)', padding: '0 8px', letterSpacing: 0.6 }}>
            CLIPS
          </div>
        )}
        {layers.slice(0, 30).map((c) => (
          <ClipRow key={c.id} clip={c} track={tracks.find((t) => t.id === c.track_id)} />
        ))}
      </div>
    </>
  );
}

function TrackHeaderRow({
  track,
  clipsCount,
  isDragging,
  showDropIndicatorAbove,
  showDropIndicatorBelow,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDropOnRow,
  onToggleVisible,
  onToggleLock,
  onDelete,
  onContextMenu,
}: {
  track: Track;
  clipsCount: number;
  isDragging: boolean;
  showDropIndicatorAbove: boolean;
  showDropIndicatorBelow: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverRow: (beforeRow: boolean) => void;
  onDropOnRow: (beforeRow: boolean) => void;
  onToggleVisible: () => void;
  onToggleLock: () => void;
  onDelete: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const handleDragOver = (e: React.DragEvent) => {
    // Only respond to our own track-reorder drag (typed via dataTransfer on dragstart).
    if (!e.dataTransfer.types.includes('application/snipette-track-id')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const beforeRow = e.clientY < rect.top + rect.height / 2;
    onDragOverRow(beforeRow);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/snipette-track-id')) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const beforeRow = e.clientY < rect.top + rect.height / 2;
    onDropOnRow(beforeRow);
  };

  return (
    <div style={{ position: 'relative' }}>
      {showDropIndicatorAbove && <DropIndicator />}
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('application/snipette-track-id', track.id);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onContextMenu={onContextMenu}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '7px 8px',
          borderRadius: 6,
          marginBottom: 2,
          opacity: track.is_visible ? (isDragging ? 0.35 : 1) : 0.45,
          background: isDragging ? 'var(--bg-hover)' : 'transparent',
          cursor: 'grab',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: track.color,
            flex: '0 0 auto',
            boxShadow: `0 0 6px ${track.color}`,
          }}
        />
        <span style={{ fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
          {track.name}
        </span>
        <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{clipsCount}</span>
        <button
          className="sn-icon-btn"
          style={{ width: 18, height: 18 }}
          onClick={onToggleVisible}
          aria-label={track.is_visible ? 'Hide track' : 'Show track'}
        >
          {track.is_visible ? <Icons.Eye size={11} /> : <Icons.EyeOff size={11} />}
        </button>
        <button
          className="sn-icon-btn"
          style={{ width: 18, height: 18, color: track.is_locked ? 'var(--accent-primary)' : 'var(--text-muted)' }}
          onClick={onToggleLock}
          aria-label={track.is_locked ? 'Unlock' : 'Lock'}
        >
          {track.is_locked ? <Icons.Lock size={11} /> : <Icons.Unlock size={11} />}
        </button>
        <button
          className="sn-icon-btn"
          style={{ width: 18, height: 18 }}
          onClick={onDelete}
          aria-label="Delete track"
          title="Delete track"
        >
          <Icons.Trash size={11} />
        </button>
      </div>
      {showDropIndicatorBelow && <DropIndicator />}
    </div>
  );
}

function DropIndicator() {
  return (
    <div
      style={{
        position: 'absolute',
        left: 4,
        right: 4,
        height: 2,
        background: 'var(--accent-primary)',
        boxShadow: '0 0 6px var(--accent-primary)',
        borderRadius: 2,
        pointerEvents: 'none',
        zIndex: 2,
      }}
    />
  );
}

function ClipRow({ clip, track }: { clip: Clip; track?: Track }) {
  if (!track) return null;
  const label = clip.text_content ?? track.name;
  return (
    <div
      onClick={() => useTimelineStore.getState().selectClip(clip.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 8px',
        borderRadius: 6,
        marginLeft: 8,
        marginBottom: 2,
        cursor: 'pointer',
        fontSize: 11,
        color: 'var(--text-secondary)',
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: track.color,
          flex: '0 0 auto',
        }}
      />
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </div>
  );
}
