import { useEffect, useMemo, useRef, useState } from 'react';
import { useTimelineStore } from '@/store/timeline.store';
import { useTimelineGeometry } from '@/hooks/useTimeline';
import { useProjectStore } from '@/store/project.store';
import { useEditorStore } from '@/store/editor.store';
import { TimelineRuler } from './timeline/TimelineRuler';
import { Playhead } from './timeline/Playhead';
import { TrackRow } from './timeline/TrackRow';
import { MarkerLayer } from './timeline/MarkerLayer';
import { Slider } from '@/components/ui/Slider';
import { Icons } from '@/components/ui/icons';
import { formatTime, pxToMs } from '@/utils/time';
import { makeMarker } from '@/utils/markers';
import type { ContextMenuItem } from '@/store/editor.store';
import type { ClipCreate, MediaAsset, Track, TrackKind } from '@shared/types';

const TRACK_HEIGHT = 42;
const TRACK_HEADER_W = 180;

export function Timeline(): JSX.Element {
  const tracks = useTimelineStore((s) => s.tracks);
  const clips = useTimelineStore((s) => s.clips);
  const durationMs = useTimelineStore((s) => s.durationMs);
  const zoom = useTimelineStore((s) => s.zoomLevel);
  const setZoom = useTimelineStore((s) => s.setZoom);
  const scroll = useTimelineStore((s) => s.scrollOffsetMs);
  const setScroll = useTimelineStore((s) => s.setScroll);
  const upsertTrack = useTimelineStore((s) => s.upsertTrack);
  const addClipLocal = useTimelineStore((s) => s.addClip);
  const assets = useProjectStore((s) => s.assets);
  const project = useProjectStore((s) => s.activeProject);
  const computeDuration = useTimelineStore((s) => s.computeDuration);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const clearSelection = useTimelineStore((s) => s.clearSelection);
  const pushToast = useEditorStore((s) => s.pushToast);
  const draggingAssetId = useEditorStore((s) => s.draggingAssetId);
  const setDraggingAssetId = useEditorStore((s) => s.setDraggingAssetId);
  const { xToTime, snapTime } = useTimelineGeometry();

  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(800);
  const activeTool = useTimelineStore((s) => s.activeTool);
  /**
   * Razor hairline cursor X in *content* coordinates (i.e. clientX - rect.left + scrollLeft).
   * Null when not hovering. Only tracked while the razor tool is active, so we avoid a
   * permanent mousemove listener.
   */
  const [razorX, setRazorX] = useState<number | null>(null);
  /**
   * Drop preview state — populated during dragover, drawn as a dashed ghost on the
   * resolved target track, cleared on drop/dragleave so the indicator never lingers.
   */
  const [dropPreview, setDropPreview] = useState<{
    trackId: string;
    trackIdx: number;
    startMs: number;
    durationMs: number;
    kindMatches: boolean;
  } | null>(null);

  useEffect(() => {
    if (!bodyRef.current) return;
    const obs = new ResizeObserver(() => setBodyWidth(bodyRef.current?.clientWidth ?? 800));
    obs.observe(bodyRef.current);
    return () => obs.disconnect();
  }, []);

  const totalTimelineWidth = Math.max(bodyWidth, (durationMs / 1000) * zoom + 200);

  const selectedClip = clips.find((c) => c.id === selectedClipIds[0]) ?? null;

  /**
   * Build an `id → asset` lookup once per assets change instead of running
   * `assets.find(...)` inside every ClipBlock render. Passed down through TrackRow
   * so ClipBlocks can do an O(1) lookup. This eliminates the O(clips × assets)
   * work that ran every render before.
   */
  const assetsById = useMemo<Map<string, MediaAsset>>(() => {
    const m = new Map<string, MediaAsset>();
    for (const a of assets) m.set(a.id, a);
    return m;
  }, [assets]);

  /**
   * rAF-throttled scroll handler — keeps the store's `scrollOffsetMs` in sync with
   * the actual scroll position so geometry callbacks (timeToX/xToTime) and snap math
   * read the correct view origin. Without this, scrollOffsetMs stayed at 0 forever,
   * breaking snap and ticks after any user scroll.
   */
  const scrollRafRef = useRef<number | null>(null);
  const handleBodyScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const offsetPx = e.currentTarget.scrollLeft;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      // Convert raw scroll-left px → ms at current zoom. `scrollOffsetMs` is in
      // milliseconds, not pixels, so we use pxToMs with a zero base offset.
      const nextScrollMs = pxToMs(offsetPx, useTimelineStore.getState().zoomLevel, 0);
      setScroll(nextScrollMs);
    });
  };

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  const handleAddTrack = async (kind: TrackKind) => {
    if (!project) return;
    const t = await window.snipette.timeline.addTrack({ project_id: project.id, type: kind });
    upsertTrack(t);
  };

  return (
    <div
      style={{
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-base)',
        display: 'grid',
        gridTemplateRows: '34px 1fr 26px',
        minHeight: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 14px',
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button className="sn-icon-btn" style={{ width: 22, height: 22 }}><Icons.Zoom size={11} /></button>
          <div style={{ width: 120 }}>
            <Slider value={zoom} min={20} max={400} onChange={setZoom} />
          </div>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
            {Math.round((zoom / 80) * 100)}%
          </span>
        </div>
        <div style={{ width: 1, height: 16, background: 'var(--border-subtle)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 10.5 }}>
          <Icons.Stack size={11} />
          <span>{tracks.length} tracks · {clips.length} clips</span>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 4 }}>
          <SnapButton />
        </div>
      </div>

      {/* Tracks */}
      <div
        style={{
          display: 'flex',
          overflow: 'hidden',
          position: 'relative',
          minHeight: 0,
        }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) clearSelection();
        }}
      >
        {/* Track header column */}
        <div
          style={{
            width: TRACK_HEADER_W,
            flex: `0 0 ${TRACK_HEADER_W}px`,
            borderRight: '1px solid var(--border-subtle)',
            background: 'var(--bg-surface)',
            overflowY: 'auto',
          }}
        >
          <div style={{ height: 24, borderBottom: '1px solid var(--border-subtle)' }} />
          {tracks.map((t, i) => (
            <TrackHeader
              key={t.id}
              track={t}
              index={i}
              onMute={() => upsertTrack({ ...t, is_muted: t.is_muted ? 0 : 1 })}
              onLock={() => upsertTrack({ ...t, is_locked: t.is_locked ? 0 : 1 })}
              onVisible={() => upsertTrack({ ...t, is_visible: t.is_visible ? 0 : 1 })}
            />
          ))}
        </div>

        {/* Track body */}
        <div
          ref={bodyRef}
          className="sn-timeline-body"
          style={{ flex: 1, position: 'relative', overflowX: 'auto', overflowY: 'auto' }}
          onScroll={handleBodyScroll}
          onMouseMove={(e) => {
            if (activeTool !== 'razor') return;
            const target = e.currentTarget;
            const rect = target.getBoundingClientRect();
            setRazorX(e.clientX - rect.left + target.scrollLeft);
          }}
          onMouseLeave={() => {
            if (razorX !== null) setRazorX(null);
          }}
          onPointerDown={(e) => {
            // Hand tool: capture pointer and drag-pan the scroll container.
            const tool = useTimelineStore.getState().activeTool;
            if (tool !== 'hand') return;
            const target = e.currentTarget;
            target.setPointerCapture(e.pointerId);
            const startX = e.clientX;
            const startScrollLeft = target.scrollLeft;
            target.style.cursor = 'grabbing';
            const move = (ev: PointerEvent) => {
              target.scrollLeft = startScrollLeft - (ev.clientX - startX);
            };
            const up = (ev: PointerEvent) => {
              target.releasePointerCapture(ev.pointerId);
              target.removeEventListener('pointermove', move);
              target.removeEventListener('pointerup', up);
              target.style.cursor = '';
            };
            target.addEventListener('pointermove', move);
            target.addEventListener('pointerup', up);
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('application/snipette-asset')) return;
            e.preventDefault();
            // `dataTransfer.getData` returns "" in dragover (Chromium security), so we
            // read the asset ID from the store shadow set by MediaLibrary on dragstart.
            const asset = assets.find((a) => a.id === draggingAssetId);
            if (!asset) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const contentY = e.clientY - rect.top + e.currentTarget.scrollTop;
            const resolved = resolveDropTarget(contentY, asset, tracks);
            if (!resolved) {
              setDropPreview(null);
              return;
            }
            const rawMs = xToTime(e.clientX - rect.left);
            const startMs = Math.max(0, snapTime(rawMs));
            const dur = asset.duration_ms ?? 4000;
            setDropPreview((prev) => {
              // Avoid setState churn when nothing changed.
              if (
                prev &&
                prev.trackId === resolved.track.id &&
                prev.startMs === startMs &&
                prev.durationMs === dur
              ) {
                return prev;
              }
              return {
                trackId: resolved.track.id,
                trackIdx: resolved.idx,
                startMs,
                durationMs: dur,
                kindMatches: resolved.kindMatches,
              };
            });
          }}
          onDragLeave={(e) => {
            // dragleave fires when entering a child element too — only clear if the
            // cursor is actually leaving the body.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDropPreview(null);
          }}
          onDrop={async (e) => {
            const assetId = e.dataTransfer.getData('application/snipette-asset');
            const asset = assets.find((a) => a.id === assetId);
            setDropPreview(null);
            setDraggingAssetId(null);
            if (!asset || !project) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const contentY = e.clientY - rect.top + e.currentTarget.scrollTop;
            const resolved = resolveDropTarget(contentY, asset, tracks);
            if (!resolved) {
              pushToast({ kind: 'error', message: `No ${asset.type} track to drop onto` });
              return;
            }
            const rawMs = xToTime(e.clientX - rect.left);
            const ms = Math.max(0, snapTime(rawMs));
            const dur = asset.duration_ms ?? 4000;
            const create: ClipCreate = {
              track_id: resolved.track.id,
              project_id: project.id,
              asset_id: asset.id,
              start_time_ms: ms,
              duration_ms: dur,
              source_in_ms: 0,
              source_out_ms: dur,
            };
            useTimelineStore.getState().pushHistory();
            const clip = await window.snipette.timeline.addClip(resolved.track.id, create);
            addClipLocal(clip);
            computeDuration();
            pushToast({ kind: 'success', message: 'Clip added' });
          }}
        >
          <div
            style={{ position: 'relative', width: totalTimelineWidth, height: 24 + tracks.length * TRACK_HEIGHT }}
            onContextMenu={(e) => {
              // Only fire when the right-click landed on this empty content area itself —
              // clip / marker / transition menus handle their own targets and stopPropagation.
              if (e.target !== e.currentTarget) return;
              e.preventDefault();
              e.stopPropagation();
              const s = useTimelineStore.getState();
              const rect = e.currentTarget.getBoundingClientRect();
              const ms = Math.max(0, xToTime(e.clientX - rect.left));
              const items: ContextMenuItem[] = [
                {
                  label: 'Add marker at playhead',
                  hint: 'M',
                  onClick: () => s.addMarker(makeMarker(useTimelineStore.getState().playheadMs)),
                },
                {
                  label: 'Add marker here',
                  onClick: () => s.addMarker(makeMarker(ms)),
                },
                { kind: 'separator' },
                { label: 'Jump to start', hint: 'Home', onClick: () => s.setPlayhead(0) },
                { label: 'Jump to end', hint: 'End', onClick: () => s.setPlayhead(useTimelineStore.getState().durationMs) },
                { kind: 'separator' },
                {
                  label: useTimelineStore.getState().snapEnabled ? 'Snap · on' : 'Snap · off',
                  hint: 'N',
                  onClick: () => s.toggleSnap(),
                },
                {
                  label: 'Select all clips',
                  hint: '⌘A',
                  disabled: useTimelineStore.getState().clips.length === 0,
                  onClick: () => s.selectAll(),
                },
              ];
              useEditorStore.getState().setContextMenu({ x: e.clientX, y: e.clientY, items });
            }}
          >
            <TimelineRuler widthPx={totalTimelineWidth} />
            <MarkerLayer />
            {tracks.map((t, i) => (
              <TrackRow
                key={t.id}
                track={t}
                idx={i}
                height={TRACK_HEIGHT}
                assetsById={assetsById}
              />
            ))}
            <Playhead height={24 + tracks.length * TRACK_HEIGHT} />
            {activeTool === 'razor' && razorX !== null && (
              <div
                style={{
                  position: 'absolute',
                  left: razorX,
                  top: 0,
                  width: 1,
                  height: 24 + tracks.length * TRACK_HEIGHT,
                  background: 'var(--accent-primary)',
                  opacity: 0.6,
                  pointerEvents: 'none',
                  zIndex: 4,
                }}
              />
            )}
            {dropPreview && (
              <DropIndicator
                trackIdx={dropPreview.trackIdx}
                startMs={dropPreview.startMs}
                durationMs={dropPreview.durationMs}
                zoom={zoom}
                trackHeight={TRACK_HEIGHT}
                redirected={!dropPreview.kindMatches}
              />
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '0 14px',
          borderTop: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface)',
          fontSize: 10.5,
          color: 'var(--text-secondary)',
        }}
      >
        <AddTrackMenu onAdd={handleAddTrack} />
        <button
          className="sn-btn-ghost"
          style={{ padding: '4px 10px', fontSize: 10.5 }}
          title="Add marker at playhead (M)"
          onClick={() => {
            const s = useTimelineStore.getState();
            s.addMarker(makeMarker(s.playheadMs));
          }}
        >
          <Icons.PlusSm size={11} /> Marker
        </button>
        <MarkerClearButton />
        <button
          className="sn-btn-ghost"
          style={{ padding: '4px 10px', fontSize: 10.5 }}
          title="Type a multi-speaker script and drop it on the timeline as styled bubbles"
          onClick={() => useEditorStore.getState().openDialogue()}
        >
          <Icons.TextT size={11} /> Dialogue
        </button>
        <button
          className="sn-btn-ghost"
          style={{ padding: '4px 10px', fontSize: 10.5 }}
          onClick={async () => {
            if (!project) return;
            const paths = await window.snipette.system.showFilePicker({
              title: 'Import media',
              multi: true,
              filters: [
                {
                  name: 'Media',
                  extensions: ['mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'm4a', 'png', 'jpg', 'jpeg'],
                },
              ],
            });
            if (paths.length) await useProjectStore.getState().importMedia(paths);
          }}
        >
          <Icons.Upload size={11} /> Import
        </button>
        <div style={{ flex: 1 }} />
        {selectedClip && (
          <span>
            Selected: <span className="mono" style={{ color: 'var(--text-primary)' }}>{formatTime(selectedClip.duration_ms, true)}</span>
          </span>
        )}
        <span style={{ width: 1, height: 12, background: 'var(--border-subtle)' }} />
        <span>
          Project: <span className="mono" style={{ color: 'var(--text-primary)' }}>{formatTime(durationMs, true)}</span>
        </span>
        <span style={{ width: 1, height: 12, background: 'var(--border-subtle)' }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--accent-primary)' }}>
          <Icons.Lock size={10} /> Local
        </span>
      </div>
    </div>
  );
}

function TrackHeader({
  track,
  index,
  onMute,
  onLock,
  onVisible,
}: {
  track: Track;
  index: number;
  onMute: () => void;
  onLock: () => void;
  onVisible: () => void;
}) {
  const setContextMenu = useEditorStore((s) => s.setContextMenu);
  const upsertTrack = useTimelineStore((s) => s.upsertTrack);
  const removeTrack = useTimelineStore((s) => s.removeTrack);
  const reorderTracksLocal = useTimelineStore((s) => s.reorderTracksLocal);
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const pushToast = useEditorStore((s) => s.pushToast);
  const project = useProjectStore((s) => s.activeProject);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = useTimelineStore.getState();
    const trackClipIds = state.clips.filter((c) => c.track_id === track.id).map((c) => c.id);

    const addTrackAt = async (kind: TrackKind, insertIndex: number) => {
      if (!project) return;
      pushHistory();
      const created = await window.snipette.timeline.addTrack({ project_id: project.id, type: kind });
      useTimelineStore.getState().upsertTrack(created);
      const ordered = [...useTimelineStore.getState().tracks]
        .filter((t) => t.id !== created.id)
        .sort((a, b) => a.order_index - b.order_index)
        .map((t) => t.id);
      const clamped = Math.max(0, Math.min(insertIndex, ordered.length));
      ordered.splice(clamped, 0, created.id);
      reorderTracksLocal(ordered);
      try {
        await window.snipette.timeline.reorderTracks(ordered);
      } catch (err) {
        pushToast({ kind: 'error', message: err instanceof Error ? err.message : 'Reorder failed.' });
      }
    };

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
      { label: 'Add track above', onClick: () => void addTrackAt(track.type, index) },
      { label: 'Add track below', onClick: () => void addTrackAt(track.type, index + 1) },
      { kind: 'separator' },
      {
        label: `Select all clips on this track${trackClipIds.length ? ` (${trackClipIds.length})` : ''}`,
        disabled: trackClipIds.length === 0,
        onClick: () => {
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

  return (
    <div
      onContextMenu={onContextMenu}
      style={{
        height: TRACK_HEIGHT,
        padding: '0 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: track.color, boxShadow: `0 0 6px ${track.color}` }} />
      <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-primary)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.name}</span>
      {track.type === 'audio' && (
        <button
          className={`sn-icon-btn ${track.is_muted ? 'active' : ''}`}
          style={{ width: 16, height: 16 }}
          onClick={onMute}
          title="Mute"
        >
          {track.is_muted ? <Icons.Mute size={10} /> : <Icons.Volume size={10} />}
        </button>
      )}
      <button className="sn-icon-btn" style={{ width: 16, height: 16 }} onClick={onVisible} title="Visibility">
        {track.is_visible ? <Icons.Eye size={10} /> : <Icons.EyeOff size={10} />}
      </button>
      <button className="sn-icon-btn" style={{ width: 16, height: 16 }} onClick={onLock} title="Lock">
        {track.is_locked ? <Icons.Lock size={10} /> : <Icons.Unlock size={10} />}
      </button>
    </div>
  );
}

function SnapButton() {
  const enabled = useTimelineStore((s) => s.snapEnabled);
  const toggle = useTimelineStore((s) => s.toggleSnap);
  return (
    <button
      className={`sn-icon-btn ${enabled ? 'active' : ''}`}
      style={{ width: 22, height: 22 }}
      onClick={toggle}
      title={`Snap ${enabled ? 'on' : 'off'}`}
    >
      <Icons.Layers size={11} />
    </button>
  );
}

/**
 * Resolve where a dropped asset should land. Prefers the track directly under the cursor
 * when that track's kind matches the asset. When it doesn't (e.g. dragging audio over a
 * video track), redirects to the nearest compatible track by index — the indicator marks
 * itself "redirected" so the user sees the jump.
 */
function resolveDropTarget(
  contentY: number,
  asset: MediaAsset,
  tracks: Track[],
): { track: Track; idx: number; kindMatches: boolean } | null {
  const expectedKind: TrackKind = asset.type === 'audio' ? 'audio' : 'video';

  if (contentY >= 24) {
    const idx = Math.floor((contentY - 24) / TRACK_HEIGHT);
    if (idx >= 0 && idx < tracks.length && tracks[idx].type === expectedKind) {
      return { track: tracks[idx], idx, kindMatches: true };
    }
  }

  const candidates = tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.type === expectedKind);
  if (candidates.length === 0) return null;

  const cursorIdx = (contentY - 24) / TRACK_HEIGHT;
  const nearest = candidates.reduce((best, c) =>
    Math.abs(c.i - cursorIdx) < Math.abs(best.i - cursorIdx) ? c : best,
  );
  return { track: nearest.t, idx: nearest.i, kindMatches: false };
}

function DropIndicator({
  trackIdx,
  startMs,
  durationMs,
  zoom,
  trackHeight,
  redirected,
}: {
  trackIdx: number;
  startMs: number;
  durationMs: number;
  zoom: number;
  trackHeight: number;
  redirected: boolean;
}) {
  // Position in content (wide-div) coordinates — left/width are NOT scroll-adjusted
  // because the indicator lives inside the scrollable content, so it tracks scroll
  // along with the clips it's previewing.
  const left = (startMs / 1000) * zoom;
  const width = Math.max(8, (durationMs / 1000) * zoom);
  const top = 24 + trackIdx * trackHeight + 3;
  const height = trackHeight - 6;
  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        width,
        height,
        borderRadius: 6,
        background: redirected
          ? 'rgba(242, 168, 58, 0.12)'
          : 'rgba(200, 242, 58, 0.14)',
        border: `1.5px dashed ${redirected ? 'var(--orange, #F2A83A)' : 'var(--accent-primary)'}`,
        boxShadow: redirected
          ? '0 0 12px rgba(242, 168, 58, 0.25)'
          : '0 0 12px rgba(200, 242, 58, 0.25)',
        pointerEvents: 'none',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        fontSize: 10,
        fontWeight: 600,
        color: redirected ? 'var(--orange, #F2A83A)' : 'var(--accent-primary)',
        letterSpacing: 0.04,
        textTransform: 'uppercase',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      {redirected ? '↳ Redirected · drop here' : 'Drop here'}
    </div>
  );
}

function AddTrackMenu({ onAdd }: { onAdd: (kind: TrackKind) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button className="sn-btn-ghost" style={{ padding: '4px 10px', fontSize: 10.5 }} onClick={() => setOpen((o) => !o)}>
        <Icons.PlusSm size={11} /> Add track
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: 4,
            minWidth: 140,
            zIndex: 100,
          }}
        >
          {(['video', 'audio', 'text', 'sticker'] as TrackKind[]).map((kind) => (
            <button
              key={kind}
              onClick={() => {
                onAdd(kind);
                setOpen(false);
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '7px 10px',
                fontSize: 12,
                borderRadius: 4,
                color: 'var(--text-primary)',
                background: 'transparent',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {kind.charAt(0).toUpperCase() + kind.slice(1)} track
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Footer chip that appears next to the "+ Marker" button. Shows the marker count and
 * lets the user clear selected/all markers without opening a context menu — handy
 * after running beat detection in dense mode and wanting to start over.
 */
function MarkerClearButton(): JSX.Element | null {
  const total = useTimelineStore((s) => s.markers.length);
  const selectedCount = useTimelineStore((s) => s.selectedMarkerIds.length);
  const removeSelectedMarkers = useTimelineStore((s) => s.removeSelectedMarkers);
  const clearMarkers = useTimelineStore((s) => s.clearMarkers);

  if (total === 0) return null;
  const hasSelection = selectedCount > 0;

  return (
    <button
      className="sn-btn-ghost"
      style={{ padding: '4px 10px', fontSize: 10.5 }}
      onClick={() => {
        if (hasSelection) {
          removeSelectedMarkers();
        } else {
          if (window.confirm(`Clear all ${total} marker${total === 1 ? '' : 's'}?`)) {
            clearMarkers();
          }
        }
      }}
      title={
        hasSelection
          ? `Delete ${selectedCount} selected marker${selectedCount === 1 ? '' : 's'}`
          : `Clear all markers (${total})`
      }
    >
      <Icons.X size={10} />{' '}
      {hasSelection ? `Delete ${selectedCount}` : `Clear ${total}`}
    </button>
  );
}

