import { useMemo, useState } from 'react';
import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import { Icons } from '@/components/ui/icons';
import { formatTime } from '@/utils/time';
import {
  KEYFRAME_PROPERTIES,
  clearTrack,
  parseKeyframes,
  removeKeyframeAt,
  upsertKeyframe,
  writeKeyframes,
  type KeyframeProperty,
  type KeyframePropertyMeta,
  type KeyframeTracks,
} from '@/utils/keyframes';
import type { Clip } from '@shared/types';

interface Props {
  clip: Clip;
}

function formatRelative(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  const totalS = Math.floor(abs / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  const milli = Math.floor(abs % 1000);
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${sign}${pad(m)}:${pad(s)}.${pad(milli, 3)}`;
}

function currentClipValue(clip: Clip, prop: KeyframeProperty): number {
  switch (prop) {
    case 'position_x': return clip.position_x;
    case 'position_y': return clip.position_y;
    case 'scale_x': return clip.scale_x;
    case 'scale_y': return clip.scale_y;
    case 'rotation': return clip.rotation;
    case 'opacity': return clip.opacity;
    case 'volume': return clip.volume;
  }
}

export function KeyframePanel({ clip }: Props): JSX.Element {
  const playheadMs = useTimelineStore((s) => s.playheadMs);
  const updateLocal = useTimelineStore((s) => s.updateClipLocal);
  const replaceClip = useTimelineStore((s) => s.replaceClip);
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const pushToast = useEditorStore((s) => s.pushToast);
  const [pickerOpen, setPickerOpen] = useState(false);

  const tracks = useMemo<KeyframeTracks>(() => parseKeyframes(clip.effects_json), [clip.effects_json]);
  const relativeMs = playheadMs - clip.start_time_ms;
  const inRange = relativeMs >= 0 && relativeMs <= clip.duration_ms;

  const persist = async (nextTracks: KeyframeTracks, message?: string) => {
    pushHistory();
    const effects_json = writeKeyframes(clip.effects_json, nextTracks);
    updateLocal(clip.id, { effects_json });
    try {
      const updated = await window.snipette.timeline.updateClip(clip.id, { effects_json });
      replaceClip(updated);
      if (message) pushToast({ kind: 'success', message });
    } catch {
      pushToast({ kind: 'error', message: 'Failed to update keyframes.' });
    }
  };

  const activeProperties = KEYFRAME_PROPERTIES.filter((p) => (tracks[p.key]?.length ?? 0) > 0);
  const inactiveProperties = KEYFRAME_PROPERTIES.filter((p) => (tracks[p.key]?.length ?? 0) === 0);

  const enableProperty = (prop: KeyframeProperty) => {
    setPickerOpen(false);
    if (!inRange) {
      pushToast({ kind: 'error', message: 'Move playhead inside the clip to add a keyframe.' });
      return;
    }
    const next = upsertKeyframe(tracks, prop, Math.round(relativeMs), currentClipValue(clip, prop));
    void persist(next, 'Keyframe added.');
  };

  const addKeyframe = (prop: KeyframeProperty) => {
    if (!inRange) {
      pushToast({ kind: 'error', message: 'Move playhead inside the clip to add a keyframe.' });
      return;
    }
    const next = upsertKeyframe(tracks, prop, Math.round(relativeMs), currentClipValue(clip, prop));
    void persist(next, 'Keyframe added.');
  };

  const removeKeyframe = (prop: KeyframeProperty, t: number) => {
    const next = removeKeyframeAt(tracks, prop, t);
    void persist(next);
  };

  const clearProperty = (prop: KeyframeProperty) => {
    const next = clearTrack(tracks, prop);
    void persist(next, 'Keyframes removed.');
  };

  return (
    <div>
      {activeProperties.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
          No keyframes. Animate a property to start.
        </div>
      ) : (
        activeProperties.map((meta) => (
          <PropertyRow
            key={meta.key}
            meta={meta}
            keyframes={tracks[meta.key] ?? []}
            relativeMs={relativeMs}
            onAdd={() => addKeyframe(meta.key)}
            onClear={() => clearProperty(meta.key)}
            onRemoveAt={(t) => removeKeyframe(meta.key, t)}
          />
        ))
      )}

      <div style={{ position: 'relative', marginTop: 6 }}>
        <button
          className="sn-btn-ghost"
          style={{ width: '100%', justifyContent: 'center' }}
          onClick={() => setPickerOpen((o) => !o)}
          disabled={inactiveProperties.length === 0}
        >
          <Icons.Plus size={11} />
          {inactiveProperties.length === 0 ? 'All properties animated' : 'Animate property'}
          <Icons.Chev size={10} style={{ transform: pickerOpen ? 'rotate(180deg)' : 'rotate(0deg)' }} />
        </button>
        {pickerOpen && inactiveProperties.length > 0 && (
          <div
            onMouseLeave={() => setPickerOpen(false)}
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              padding: 4,
              boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
              zIndex: 20,
            }}
          >
            {inactiveProperties.map((p) => (
              <button
                key={p.key}
                onClick={() => enableProperty(p.key)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 8px',
                  fontSize: 11,
                  borderRadius: 4,
                  color: 'var(--text-primary)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mono" style={{ fontSize: 9.5, color: 'var(--text-muted)', marginTop: 8 }}>
        playhead · {formatTime(playheadMs, true)} ({formatRelative(relativeMs)} in clip)
      </div>
    </div>
  );
}

function PropertyRow({
  meta,
  keyframes,
  relativeMs,
  onAdd,
  onClear,
  onRemoveAt,
}: {
  meta: KeyframePropertyMeta;
  keyframes: { t: number; v: number }[];
  relativeMs: number;
  onAdd: () => void;
  onClear: () => void;
  onRemoveAt: (t: number) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const atPlayhead = keyframes.some((k) => Math.abs(k.t - relativeMs) < 16);

  return (
    <div
      style={{
        background: 'var(--bg-base)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 6,
        padding: 8,
        marginBottom: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <button
          onClick={() => setOpen((o) => !o)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, textAlign: 'left' }}
        >
          <Icons.Chev size={10} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', color: 'var(--text-secondary)' }} />
          <span style={{ fontSize: 12, fontWeight: 600 }}>{meta.label}</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {keyframes.length}
          </span>
        </button>
        <button
          className="sn-icon-btn"
          style={{ width: 22, height: 22 }}
          onClick={onAdd}
          title={atPlayhead ? 'Update keyframe at playhead' : 'Add keyframe at playhead'}
        >
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: atPlayhead ? 'var(--accent-primary)' : 'transparent',
              border: '1.5px solid var(--accent-primary)',
            }}
          />
        </button>
        <button
          className="sn-icon-btn"
          style={{ width: 22, height: 22 }}
          onClick={onClear}
          title="Remove all keyframes for this property"
          aria-label="Remove all"
        >
          <Icons.Trash size={11} />
        </button>
      </div>

      {open && keyframes.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {keyframes.map((k) => (
            <div
              key={k.t}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 4px',
                borderRadius: 4,
                background: Math.abs(k.t - relativeMs) < 16 ? 'rgba(200,242,58,0.08)' : 'transparent',
              }}
            >
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)', flex: '0 0 64px' }}>
                {formatRelative(k.t)}
              </span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-primary)', flex: 1, minWidth: 0 }}>
                {k.v.toFixed(2)}{meta.suffix ?? ''}
              </span>
              <button
                className="sn-icon-btn"
                style={{ width: 18, height: 18 }}
                onClick={() => onRemoveAt(k.t)}
                aria-label="Remove keyframe"
              >
                <Icons.X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
