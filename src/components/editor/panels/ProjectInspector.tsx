import { useProjectStore } from '@/store/project.store';
import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import { InspectorSection, Field } from '../RightPanel';
import { Icons } from '@/components/ui/icons';
import { formatTime } from '@/utils/time';
import { fileSizeLabel } from '@/utils/file';

export function ProjectInspector(): JSX.Element {
  const project = useProjectStore((s) => s.activeProject);
  const assets = useProjectStore((s) => s.assets);
  const importMedia = useProjectStore((s) => s.importMedia);
  const durationMs = useTimelineStore((s) => s.durationMs);
  const openExport = useEditorStore((s) => s.openExport);

  if (!project) return <div />;

  const pick = async (kind: 'video' | 'audio' | 'image') => {
    const extensions =
      kind === 'audio'
        ? ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus']
        : kind === 'image'
          ? ['png', 'jpg', 'jpeg', 'gif', 'webp']
          : ['mp4', 'mov', 'mkv', 'webm', 'm4v'];
    const paths = await window.snipette.system.showFilePicker({
      title: `Add ${kind}`,
      multi: true,
      filters: [{ name: kind.toUpperCase(), extensions }],
    });
    if (paths.length) await importMedia(paths);
  };

  return (
    <div>
      <InspectorSection title="Project" defaultOpen>
        <Field label="Name">
          <div style={{ background: 'var(--bg-base)', borderRadius: 6, padding: '8px 10px', border: '1px solid var(--border-subtle)', fontSize: 12 }}>
            {project.name}
          </div>
        </Field>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Field label="Format">
            <div style={{ background: 'var(--bg-base)', borderRadius: 6, padding: '7px 10px', fontSize: 11, border: '1px solid var(--border-subtle)' }} className="mono">
              {project.format}
            </div>
          </Field>
          <Field label="Resolution">
            <div style={{ background: 'var(--bg-base)', borderRadius: 6, padding: '7px 10px', fontSize: 11, border: '1px solid var(--border-subtle)' }} className="mono">
              {project.width}×{project.height}
            </div>
          </Field>
          <Field label="FPS">
            <div style={{ background: 'var(--bg-base)', borderRadius: 6, padding: '7px 10px', fontSize: 11, border: '1px solid var(--border-subtle)' }} className="mono">
              {project.fps}
            </div>
          </Field>
        </div>
        <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-base)', borderRadius: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
          Duration: <span className="mono" style={{ color: 'var(--text-primary)' }}>{formatTime(durationMs, true)}</span>
          <br />
          Files: <span style={{ color: 'var(--text-primary)' }}>{assets.length}</span>
        </div>
      </InspectorSection>

      <InspectorSection title="Quick add">
        <button className="sn-btn-ghost" style={{ width: '100%', justifyContent: 'center', marginBottom: 6 }} onClick={() => pick('video')}>
          <Icons.Image size={12} /> Add video
        </button>
        <button className="sn-btn-ghost" style={{ width: '100%', justifyContent: 'center', marginBottom: 6 }} onClick={() => pick('audio')}>
          <Icons.Music size={12} /> Add audio
        </button>
        <button className="sn-btn-ghost" style={{ width: '100%', justifyContent: 'center' }} onClick={() => pick('image')}>
          <Icons.Image size={12} /> Add image
        </button>
      </InspectorSection>

      <InspectorSection title="Media bin">
        {assets.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '8px 0' }}>
            Drop media on the window or click Import.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {assets.map((a) => (
              <div
                key={a.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/snipette-asset', a.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                style={{
                  padding: 8,
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 6,
                  fontSize: 11,
                  cursor: 'grab',
                }}
                title={a.original_path}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {a.type === 'video' ? <Icons.Image size={11} stroke="var(--accent-primary)" /> : a.type === 'audio' ? <Icons.Music size={11} stroke="var(--accent-tertiary)" /> : <Icons.Image size={11} stroke="var(--accent-secondary)" />}
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                    {a.original_path.split(/[\\/]/).pop()}
                  </span>
                </div>
                <div className="mono" style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 3 }}>
                  {formatTime(a.duration_ms ?? 0, true)} · {fileSizeLabel(a.file_size ?? 0)}
                </div>
              </div>
            ))}
          </div>
        )}
      </InspectorSection>

      <InspectorSection title="Export">
        <button className="sn-btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={openExport}>
          Open export → <Icons.Arrow size={12} stroke="#0A0A0C" />
        </button>
      </InspectorSection>
    </div>
  );
}
