import { useEffect, useRef } from 'react';
import { useEditorStore } from '@/store/editor.store';
import { useTimelineStore } from '@/store/timeline.store';
import { useProjectStore } from '@/store/project.store';
import type { TrackKind } from '@shared/types';

const GROUPS: { title: string; emoji: string[] }[] = [
  { title: 'Reactions', emoji: ['🔥', '✨', '💯', '👀', '😂', '🤯', '🥺', '😎'] },
  { title: 'Arrows', emoji: ['➡️', '⬅️', '⬆️', '⬇️', '↩️', '↪️', '🔄', '🔁'] },
  { title: 'Hearts', emoji: ['❤️', '🧡', '💚', '💙', '💜', '🖤', '🤍', '💔'] },
  { title: 'Symbols', emoji: ['⭐', '🎯', '🏆', '🚀', '⚡', '🌈', '🎉', '🎁'] },
  { title: 'Faces', emoji: ['😀', '😁', '😊', '😍', '🤔', '😴', '🙃', '🤩'] },
];

/**
 * Floating sticker picker. Drops the chosen emoji as a 1.5-second clip on the first
 * sticker (or text) track at the cursor time. Renders the same way as text clips do.
 */
export function StickerPicker(): JSX.Element | null {
  const picker = useEditorStore((s) => s.stickerPicker);
  const close = useEditorStore((s) => s.closeStickerPicker);
  const pushToast = useEditorStore((s) => s.pushToast);
  const tracks = useTimelineStore((s) => s.tracks);
  const addClipLocal = useTimelineStore((s) => s.addClip);
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const computeDuration = useTimelineStore((s) => s.computeDuration);
  const project = useProjectStore((s) => s.activeProject);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!picker) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [picker, close]);

  if (!picker || !project) return null;

  const dropSticker = async (emoji: string) => {
    // Prefer a sticker / effect track, fall back to a text track.
    const preferredKinds: TrackKind[] = ['sticker', 'effect', 'text'];
    let track = tracks.find((t) => t.type === preferredKinds[0]);
    for (const k of preferredKinds) {
      if (track) break;
      track = tracks.find((t) => t.type === k);
    }
    if (!track) {
      pushToast({ kind: 'error', message: 'Add a sticker, effect, or text track first.' });
      return;
    }
    const dur = 1500;
    pushHistory();
    const created = await window.snipette.timeline.addClip(track.id, {
      track_id: track.id,
      project_id: project.id,
      start_time_ms: Math.max(0, picker.atTimeMs),
      duration_ms: dur,
      source_in_ms: 0,
      source_out_ms: dur,
      text_content: emoji,
      text_style_json: JSON.stringify({
        font_family: 'system-ui',
        font_size: 120,
        color: '#FFFFFF',
        stroke_color: 'transparent',
        stroke_width: 0,
      }),
    });
    addClipLocal(created);
    computeDuration();
    pushToast({ kind: 'success', message: `${emoji} added` });
    close();
  };

  // Clamp position to keep the popover on-screen.
  const POPOVER_W = 280;
  const POPOVER_H = 320;
  const left = Math.min(Math.max(8, picker.x), window.innerWidth - POPOVER_W - 8);
  const top = Math.min(Math.max(8, picker.y), window.innerHeight - POPOVER_H - 8);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left,
        top,
        width: POPOVER_W,
        maxHeight: POPOVER_H,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
        zIndex: 1500,
        overflow: 'auto',
        userSelect: 'none',
      }}
    >
      <div style={{ padding: '10px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="sn-section-label">Stickers</span>
        <span className="mono" style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>esc</span>
      </div>
      {GROUPS.map((g) => (
        <div key={g.title} style={{ padding: '4px 10px 10px' }}>
          <div style={{ fontSize: 9.5, color: 'var(--text-muted)', letterSpacing: 0.6, marginBottom: 4, textTransform: 'uppercase', fontWeight: 600 }}>
            {g.title}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2 }}>
            {g.emoji.map((e) => (
              <button
                key={e}
                onClick={() => dropSticker(e)}
                title={`Add ${e}`}
                style={{
                  aspectRatio: '1',
                  fontSize: 18,
                  borderRadius: 4,
                  background: 'transparent',
                  transition: 'background .12s',
                }}
                onMouseEnter={(ev) => (ev.currentTarget.style.background = 'var(--bg-hover)')}
                onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
