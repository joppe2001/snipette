import { useMemo, useState } from 'react';
import { useProjectStore } from '@/store/project.store';
import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import type { ContextMenuItem } from '@/store/editor.store';
import { useThumbnail } from '@/hooks/useThumbnail';
import { Icons } from '@/components/ui/icons';
import { formatTime } from '@/utils/time';
import { fileSizeLabel, basename } from '@/utils/file';
import type { MediaAsset, Track } from '@shared/types';

type FilterKind = 'all' | 'video' | 'audio' | 'image';

/**
 * CapCut-style media library. Imported assets show as draggable thumbnail cards with type,
 * duration, and size. Click adds to the timeline at the current playhead position. Drag drops
 * onto the timeline at the cursor.
 *
 * Proxy progress (background H.264 transcode of HEVC/ProRes sources for preview playback) is
 * surfaced per-card via a thin lime bar across the bottom.
 */
export function MediaLibrary({ proxyProgress }: { proxyProgress: Map<string, number> }): JSX.Element {
  const assets = useProjectStore((s) => s.assets);
  const importMedia = useProjectStore((s) => s.importMedia);
  const project = useProjectStore((s) => s.activeProject);
  const pushToast = useEditorStore((s) => s.pushToast);
  const [filter, setFilter] = useState<FilterKind>('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((a) => {
      if (filter !== 'all' && a.type !== filter) return false;
      if (q && !basename(a.original_path).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [assets, filter, query]);

  const pickFiles = async () => {
    if (!project) return;
    const paths = await window.snipette.system.showFilePicker({
      title: 'Import media',
      multi: true,
      filters: [
        {
          name: 'Media',
          extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'png', 'jpg', 'jpeg', 'gif', 'webp'],
        },
      ],
    });
    if (paths.length) {
      const newAssets = await importMedia(paths);
      if (newAssets.length) pushToast({ kind: 'success', message: `Imported ${newAssets.length}.` });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div style={{ padding: '8px 12px 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="sn-section-label" style={{ flex: 1 }}>Library</span>
        <span className="sn-pill" style={{ padding: '1px 6px', fontSize: 9.5 }}>{assets.length}</span>
      </div>

      <div style={{ padding: '0 10px 8px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'var(--bg-base)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 6,
            padding: '5px 8px',
            marginBottom: 6,
          }}
        >
          <Icons.Search size={10} stroke="var(--text-muted)" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            style={{ flex: 1, fontSize: 11, color: 'var(--text-primary)', background: 'transparent' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'video', 'audio', 'image'] as FilterKind[]).map((k) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              style={{
                flex: 1,
                fontSize: 10,
                padding: '4px 0',
                fontWeight: 600,
                borderRadius: 4,
                color: filter === k ? 'var(--accent-primary)' : 'var(--text-secondary)',
                background: filter === k ? 'rgba(200,242,58,0.08)' : 'transparent',
                textTransform: 'capitalize',
              }}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, margin: '0 10px 8px' }}>
        <button
          onClick={pickFiles}
          style={{
            flex: 1,
            padding: '8px 10px',
            border: '1px dashed rgba(200,242,58,0.4)',
            borderRadius: 8,
            background: 'rgba(200,242,58,0.04)',
            color: 'var(--accent-primary)',
            fontSize: 11,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <Icons.Upload size={11} /> Import
        </button>
        <button
          onClick={() => useEditorStore.getState().openVoiceStudio()}
          title="Record voiceover or punch-in audio"
          style={{
            flex: 1,
            padding: '8px 10px',
            border: '1px dashed rgba(242, 58, 94, 0.4)',
            borderRadius: 8,
            background: 'rgba(242, 58, 94, 0.05)',
            color: 'var(--red-alert, #F23A5E)',
            fontSize: 11,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--red-alert, #F23A5E)',
              boxShadow: '0 0 6px var(--red-alert, #F23A5E)',
            }}
          />
          Record
        </button>
      </div>

      <div style={{ overflowY: 'auto', flex: 1, padding: '0 8px 8px' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: '24px 12px', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.6 }}>
            {assets.length === 0 ? 'No media yet. Drop files anywhere, or click Import.' : 'No matches in the current filter.'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
            {filtered.map((a) => (
              <AssetCard key={a.id} asset={a} proxyPercent={proxyProgress.get(a.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AssetCard({ asset, proxyPercent }: { asset: MediaAsset; proxyPercent: number | undefined }) {
  const tracks = useTimelineStore((s) => s.tracks);
  const clips = useTimelineStore((s) => s.clips);
  const playheadMs = useTimelineStore((s) => s.playheadMs);
  const durationMs = useTimelineStore((s) => s.durationMs);
  const addClipLocal = useTimelineStore((s) => s.addClip);
  const computeDuration = useTimelineStore((s) => s.computeDuration);
  const project = useProjectStore((s) => s.activeProject);
  const removeAsset = useProjectStore((s) => s.removeAsset);
  const pushToast = useEditorStore((s) => s.pushToast);
  const setContextMenu = useEditorStore((s) => s.setContextMenu);
  const thumb = useThumbnail(asset.type === 'video' ? asset.id : null, 500);

  /** Insert a clip on the given track at `startMs`. */
  const insertOnTrack = async (track: Track, startMs: number) => {
    if (!project) return;
    const dur = asset.duration_ms ?? 4000;
    useTimelineStore.getState().pushHistory();
    const clip = await window.snipette.timeline.addClip(track.id, {
      track_id: track.id,
      project_id: project.id,
      asset_id: asset.id,
      start_time_ms: Math.max(0, startMs),
      duration_ms: dur,
      source_in_ms: 0,
      source_out_ms: dur,
    });
    addClipLocal(clip);
    computeDuration();
    pushToast({ kind: 'success', message: `Added to ${track.name}` });
  };

  const compatibleTracks = useMemo(() => {
    return tracks.filter((t) => {
      if (asset.type === 'audio') return t.type === 'audio';
      if (asset.type === 'image' || asset.type === 'video') return t.type === 'video';
      return false;
    });
  }, [tracks, asset.type]);

  const defaultTrack = compatibleTracks[0];

  const addToTimeline = async () => {
    if (!defaultTrack) {
      pushToast({ kind: 'error', message: 'No suitable track on this project.' });
      return;
    }
    await insertOnTrack(defaultTrack, playheadMs);
  };

  /** Earliest empty slot on a track at-or-after `fromMs`. */
  const nextOpenStart = (trackId: string, fromMs: number): number => {
    const onTrack = clips
      .filter((c) => c.track_id === trackId)
      .sort((a, b) => a.start_time_ms - b.start_time_ms);
    let cursor = fromMs;
    for (const c of onTrack) {
      const end = c.start_time_ms + c.duration_ms;
      if (cursor + (asset.duration_ms ?? 4000) <= c.start_time_ms) break;
      if (end > cursor) cursor = end;
    }
    return cursor;
  };

  const openContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [];

    items.push({
      label: 'Add at playhead',
      hint: 'Dbl-click',
      disabled: !defaultTrack,
      onClick: () => addToTimeline(),
    });
    items.push({
      label: 'Append at end of project',
      disabled: !defaultTrack,
      onClick: () => defaultTrack && insertOnTrack(defaultTrack, durationMs),
    });

    if (compatibleTracks.length > 1) {
      items.push({ kind: 'separator' });
      items.push({ kind: 'header', label: `Add to specific ${asset.type === 'audio' ? 'audio' : 'video'} track` });
      for (const t of compatibleTracks) {
        items.push({
          label: t.name,
          onClick: () => insertOnTrack(t, nextOpenStart(t.id, playheadMs)),
        });
      }
    }

    if (asset.type === 'video') {
      items.push({ kind: 'separator' });
      items.push({
        label: asset.proxy_path ? 'Regenerate preview proxy' : 'Generate preview proxy',
        hint: 'H.264 540p',
        onClick: async () => {
          await window.snipette.media.regenerateProxy(asset.id);
          pushToast({ kind: 'info', message: 'Regenerating preview proxy in background…' });
        },
      });
    }

    items.push({ kind: 'separator' });
    items.push({
      label: 'Reveal source in Finder',
      onClick: () => window.snipette.system.openInFinder(asset.original_path),
    });
    items.push({
      label: 'Properties',
      onClick: () =>
        pushToast({
          kind: 'info',
          message: [
            basename(asset.original_path),
            asset.duration_ms != null ? `Duration ${formatTime(asset.duration_ms, true)}` : null,
            asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
            asset.fps ? `${asset.fps.toFixed(2)} fps` : null,
            asset.codec ?? null,
            fileSizeLabel(asset.file_size ?? 0),
          ]
            .filter(Boolean)
            .join(' · '),
        }),
    });

    items.push({ kind: 'separator' });
    items.push({
      label: 'Remove from project',
      danger: true,
      hint: 'Keeps source file',
      onClick: async () => {
        if (!confirm(`Remove "${basename(asset.original_path)}" from this project?\n\nThe original file on disk is not deleted.`)) return;
        await window.snipette.media.delete(asset.id);
        removeAsset(asset.id);
        // Local-state cleanup for clips that referenced it: null their asset_id so they don't crash.
        for (const c of clips) {
          if (c.asset_id === asset.id) {
            useTimelineStore.getState().updateClipLocal(c.id, { asset_id: null });
          }
        }
        pushToast({ kind: 'success', message: 'Removed from project.' });
      },
    });

    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const TypeIcon = asset.type === 'audio' ? Icons.Music : asset.type === 'image' ? Icons.Image : Icons.Cube;
  const accentColor =
    asset.type === 'video'
      ? 'var(--accent-primary)'
      : asset.type === 'audio'
        ? 'var(--orange)'
        : 'var(--accent-tertiary)';

  return (
    <div
      draggable
      title={asset.original_path}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/snipette-asset', asset.id);
        e.dataTransfer.effectAllowed = 'copy';
        // Shadow the asset ID into the store too — Chromium blocks `getData` during
        // `dragover` events, so the Timeline reads it from here to preview the drop.
        useEditorStore.getState().setDraggingAssetId(asset.id);
      }}
      onDragEnd={() => useEditorStore.getState().setDraggingAssetId(null)}
      onDoubleClick={addToTimeline}
      onContextMenu={openContextMenu}
      style={{
        position: 'relative',
        background: 'var(--bg-base)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 6,
        overflow: 'hidden',
        cursor: 'grab',
        transition: 'border-color .12s, transform .12s',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#2a2a3a')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
    >
      <div
        style={{
          aspectRatio: '16/10',
          background: thumb ? `url(${thumb}) center / cover` : 'linear-gradient(135deg, #1a1a22, #0a0a10)',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {!thumb && <TypeIcon size={22} stroke={accentColor} />}
        <div
          style={{
            position: 'absolute',
            top: 4,
            left: 4,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            padding: '1px 5px',
            background: 'rgba(10,10,12,0.85)',
            borderRadius: 3,
            color: accentColor,
            fontSize: 8.5,
            fontWeight: 700,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
          }}
        >
          <span style={{ width: 4, height: 4, borderRadius: '50%', background: accentColor }} />
          {asset.type}
        </div>
        {asset.duration_ms != null && asset.type !== 'image' && (
          <div
            style={{
              position: 'absolute',
              bottom: 4,
              right: 4,
              padding: '1px 5px',
              background: 'rgba(10,10,12,0.85)',
              borderRadius: 3,
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: '#fff',
            }}
          >
            {formatTime(asset.duration_ms)}
          </div>
        )}
        {proxyPercent != null && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: 2,
              background: 'rgba(0,0,0,0.4)',
            }}
          >
            <div
              style={{
                width: `${proxyPercent}%`,
                height: '100%',
                background: 'var(--accent-primary)',
                boxShadow: '0 0 6px rgba(200,242,58,0.6)',
              }}
            />
          </div>
        )}
      </div>
      <div style={{ padding: '5px 7px 6px' }}>
        <div
          style={{
            fontSize: 10.5,
            color: 'var(--text-primary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontWeight: 500,
          }}
        >
          {basename(asset.original_path)}
        </div>
        <div className="mono" style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>
          {fileSizeLabel(asset.file_size ?? 0)}
          {asset.type === 'video' && asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
        </div>
      </div>
    </div>
  );
}
