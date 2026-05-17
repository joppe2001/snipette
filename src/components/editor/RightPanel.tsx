import { useState } from 'react';
import { useTimelineStore } from '@/store/timeline.store';
import { useProjectStore } from '@/store/project.store';
import { Icons } from '@/components/ui/icons';
import { VideoInspector } from './panels/VideoInspector';
import { TextInspector } from './panels/TextInspector';
import { AudioInspector } from './panels/AudioInspector';
import { ProjectInspector } from './panels/ProjectInspector';
import { formatTime } from '@/utils/time';

export function RightPanel(): JSX.Element {
  const selectedIds = useTimelineStore((s) => s.selectedClipIds);
  const clips = useTimelineStore((s) => s.clips);
  const tracks = useTimelineStore((s) => s.tracks);
  const activeTool = useTimelineStore((s) => s.activeTool);
  const project = useProjectStore((s) => s.activeProject);

  const clip = clips.find((c) => c.id === selectedIds[0]) ?? null;
  const track = clip ? tracks.find((t) => t.id === clip.track_id) : null;

  let content: JSX.Element;
  let headerLabel: string;
  let headerColor = 'var(--accent-primary)';

  // Text tool active + no clip selected → show the full TextInspector wired to
  // an in-memory draft clip. The user composes everything (style, animation,
  // hooks, templates) on the draft and drags the preview tile onto the canvas
  // / timeline to actually place a clip. When a clip IS selected the inspector
  // operates on that real clip instead.
  if (activeTool === 'text' && !clip) {
    content = <TextInspector clip={null} />;
    headerLabel = 'Text designer';
  } else if (!clip || !track) {
    content = <ProjectInspector />;
    headerLabel = 'Project';
  } else if (track.type === 'text' || track.type === 'sticker' || track.type === 'effect') {
    content = <TextInspector clip={clip} />;
    headerLabel = track.type === 'text' ? 'Text layer' : track.type === 'sticker' ? 'Sticker' : 'Effect';
    headerColor = track.color;
  } else if (track.type === 'audio') {
    content = <AudioInspector clip={clip} />;
    headerLabel = 'Audio clip';
    headerColor = track.color;
  } else {
    content = <VideoInspector clip={clip} />;
    headerLabel = track.type === 'video' ? 'Video clip' : 'Clip';
    headerColor = track.color;
  }

  return (
    <div
      style={{
        borderLeft: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        height: '100%',
      }}
    >
      <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: headerColor }} />
          <span className="sn-section-label">{headerLabel} {clip ? 'selected' : 'properties'}</span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {clip ? clip.text_content ? `"${clip.text_content.slice(0, 28)}"` : track?.name ?? 'Clip' : project?.name ?? '—'}
        </div>
        {clip && (
          <div className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
            {formatTime(clip.start_time_ms, true)} → {formatTime(clip.start_time_ms + clip.duration_ms, true)} ·{' '}
            {(clip.duration_ms / 1000).toFixed(2)}s
          </div>
        )}
      </div>
      <div style={{ overflow: 'auto', flex: 1 }}>{content}</div>
    </div>
  );
}

export function InspectorSection({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <button
        onClick={() => setOpen(!open)}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        style={{
          width: '100%',
          padding: '10px 12px 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          transition: 'background .12s',
        }}
      >
        <span className="sn-section-label">{title}</span>
        <Icons.Chev size={11} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', color: 'var(--text-secondary)' }} />
      </button>
      {open && <div style={{ padding: '0 14px 12px' }}>{children}</div>}
    </div>
  );
}

export function Field({ label, flex = 1, children }: { label: string; flex?: number; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ flex, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 9.5, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>
        {label}
      </span>
      {children}
    </div>
  );
}

export function FieldRow({ children }: { children: React.ReactNode }): JSX.Element {
  return <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-end' }}>{children}</div>;
}
