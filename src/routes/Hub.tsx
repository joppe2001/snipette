import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjectStore } from '@/store/project.store';
import { useEditorStore } from '@/store/editor.store';
import { Icons, Mark } from '@/components/ui/icons';
import { formatTime, relativeTimeAgo } from '@/utils/time';
import { fileSizeLabel } from '@/utils/file';
import { useFileDrop } from '@/hooks/useDragDrop';
import type { Format, Project } from '@shared/types';

/** Pick 9:16 / 16:9 / 1:1 from a clip's natural aspect ratio. */
function inferFormat(w: number | null, h: number | null): Format {
  if (!w || !h) return '9:16';
  const ratio = w / h;
  if (ratio >= 1.4) return '16:9';
  if (ratio <= 0.7) return '9:16';
  return '1:1';
}

function canvasSizeFor(format: Format, srcW: number | null, srcH: number | null): { width: number; height: number } {
  switch (format) {
    case '16:9':
      return { width: 1920, height: 1080 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '9:16':
      return { width: 1080, height: 1920 };
    case 'custom':
    default:
      return { width: srcW ?? 1080, height: srcH ?? 1920 };
  }
}

const TONES: Record<string, [string, string, string]> = {
  warm: ['#3a2614', '#7a4520', '#2a1810'],
  amber: ['#4a3a14', '#8a5a20', '#1a1410'],
  red: ['#3a1418', '#8a2030', '#1a0a10'],
  blue: ['#102a4a', '#1a4a8a', '#0a1020'],
  pink: ['#3a143a', '#8a2080', '#1a0a1a'],
  mono: ['#1a1a22', '#3a3a4a', '#0a0a10'],
};

function toneFor(id: string): [string, string, string] {
  const keys = Object.keys(TONES);
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return TONES[keys[Math.abs(h) % keys.length]];
}

type HubView = 'home' | 'projects' | 'templates' | 'queue';

export function Hub(): JSX.Element {
  const { projects, loadProjects, deleteProject, createProject, openProject } = useProjectStore();
  const openFormatPicker = useEditorStore((s) => s.openFormatPicker);
  const openSettings = useEditorStore((s) => s.openSettings);
  const pushToast = useEditorStore((s) => s.pushToast);
  const [filter, setFilter] = useState<'All' | '9:16' | '16:9' | '1:1'>('All');
  const [version, setVersion] = useState('');
  const [freeBytes, setFreeBytes] = useState(0);
  const [cacheBytes, setCacheBytes] = useState(0);
  const [view, setView] = useState<HubView>('home');
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    void loadProjects();
    void window.snipette.system.appInfo().then((info) => setVersion(info.version));
    void window.snipette.system.getFreeSpace().then(setFreeBytes);
    void window.snipette.system.getCacheSize().then(setCacheBytes);
  }, [loadProjects]);

  // Dropping a file onto the Hub auto-creates a project sized to the file's aspect ratio,
  // imports the file, and jumps into the editor.
  const { dragging } = useFileDrop(async (paths) => {
    if (paths.length === 0) return;
    try {
      const first = paths[0];
      const info = await window.snipette.media.probe(first);
      const format = inferFormat(info.width, info.height);
      const { width, height } = canvasSizeFor(format, info.width, info.height);
      const name = first.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'Imported clip';
      const project = await createProject({
        name,
        format,
        width,
        height,
        fps: Math.round(info.fps ?? 30),
      });
      await openProject(project.id);
      const newAssets = await window.snipette.media.import(project.id, paths);
      // Drop the first asset on the V1 track at t=0.
      const tl = await window.snipette.timeline.list(project.id);
      const v1 = tl.tracks.find((t) => t.type === 'video');
      if (v1 && newAssets[0]) {
        const dur = newAssets[0].duration_ms ?? 4000;
        await window.snipette.timeline.addClip(v1.id, {
          track_id: v1.id,
          project_id: project.id,
          asset_id: newAssets[0].id,
          start_time_ms: 0,
          duration_ms: dur,
          source_in_ms: 0,
          source_out_ms: dur,
        });
      }
      pushToast({ kind: 'success', message: `Created "${name}" and imported.` });
      navigate(`/editor/${project.id}`);
    } catch (e) {
      pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Failed to import drop.' });
    }
  });

  const filtered = projects.filter((p) => {
    if (filter !== 'All' && p.format !== filter) return false;
    if (query.trim() && !p.name.toLowerCase().includes(query.trim().toLowerCase())) return false;
    return true;
  });

  const VIEW_LABELS: Record<HubView, string> = {
    home: 'HOME',
    projects: 'PROJECTS',
    templates: 'TEMPLATES',
    queue: 'EXPORT QUEUE',
  };

  return (
    <div className="sn-grid-bg" style={{ width: '100%', height: '100%', display: 'grid', gridTemplateColumns: '64px 1fr', overflow: 'hidden', position: 'relative' }}>
      {dragging && (
        <div className="sn-drop-overlay">DROP TO CREATE PROJECT</div>
      )}
      <Sidebar view={view} onView={setView} onSettings={openSettings} />
      <div style={{ display: 'grid', gridTemplateRows: '64px 1fr 40px', minHeight: 0 }}>
        <TopBar version={version} label={VIEW_LABELS[view]} />
        <div style={{ overflow: 'auto', padding: '24px 40px 40px' }}>
          {view === 'home' && (
            <>
              <NewProjectHero onClick={openFormatPicker} />
              {projects.length === 0 ? (
                <EmptyState onCreate={openFormatPicker} />
              ) : (
                <RecentSection
                  projects={filtered.slice(0, 9)}
                  total={projects.length}
                  filter={filter}
                  onFilter={setFilter}
                  onDelete={deleteProject}
                />
              )}
            </>
          )}
          {view === 'projects' && (
            <ProjectsView
              projects={filtered}
              total={projects.length}
              filter={filter}
              onFilter={setFilter}
              onDelete={deleteProject}
              query={query}
              onQuery={setQuery}
              onCreate={openFormatPicker}
            />
          )}
          {view === 'templates' && <TemplatesView onCreate={openFormatPicker} />}
          {view === 'queue' && <ExportQueueView />}
        </div>
        <BottomBar freeBytes={freeBytes} cacheBytes={cacheBytes} />
      </div>
    </div>
  );
}

function Sidebar({ view, onView, onSettings }: { view: HubView; onView: (v: HubView) => void; onSettings: () => void }) {
  const isMac = navigator.platform.startsWith('Mac');
  const items: { id: HubView; title: string; Icon: typeof Icons.Home }[] = [
    { id: 'home', title: 'Home', Icon: Icons.Home },
    { id: 'projects', title: 'Projects', Icon: Icons.Folder },
    { id: 'templates', title: 'Templates', Icon: Icons.Stack },
    { id: 'queue', title: 'Export queue', Icon: Icons.Upload },
  ];
  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: isMac ? 44 : 20,
        paddingBottom: 20,
        gap: 6,
      }}
    >
      <div style={{ marginBottom: 18 }}>
        <Mark size={28} />
      </div>
      {items.map((it) => {
        const active = view === it.id;
        return (
          <button
            key={it.id}
            className={`sn-icon-btn ${active ? 'active' : ''}`}
            title={it.title}
            onClick={() => onView(it.id)}
            style={{ width: 40, height: 40, position: 'relative', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <it.Icon size={17} />
            {active && (
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 8,
                  bottom: 8,
                  width: 2,
                  background: 'var(--accent-primary)',
                  borderRadius: '0 2px 2px 0',
                }}
              />
            )}
          </button>
        );
      })}
      <div style={{ flex: 1 }} />
      <button
        className="sn-icon-btn"
        title="Settings"
        style={{ width: 40, height: 40, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={onSettings}
      >
        <Icons.Settings size={17} />
      </button>
    </div>
  );
}

function TopBar({ version, label }: { version: string; label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 32px',
        borderBottom: '1px solid var(--border-subtle)',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <div className="display" style={{ fontSize: 22, letterSpacing: '0.06em' }}>
        {label}
      </div>
      <span
        className="sn-pill"
        style={{ background: 'transparent', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Icons.Drop size={10} stroke="var(--accent-primary)" />
        <span style={{ color: 'var(--accent-primary)' }}>v{version || '0.1.0'} · local build</span>
      </span>
      <div style={{ flex: 1 }} />
    </div>
  );
}

function NewProjectHero({ onClick }: { onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        position: 'relative',
        width: '100%',
        height: 280,
        border: '2px dashed rgba(200,242,58,0.45)',
        borderRadius: 24,
        background:
          'radial-gradient(circle at 20% 30%, rgba(200,242,58,0.07), transparent 40%),' +
          'radial-gradient(circle at 80% 70%, rgba(242,58,200,0.05), transparent 40%),' +
          'var(--bg-surface)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 56px',
        overflow: 'hidden',
        cursor: 'pointer',
      }}
    >
      <div style={{ position: 'absolute', left: -40, top: 0, bottom: 0, width: 32, background: 'repeating-linear-gradient(0, transparent 0 18px, rgba(200,242,58,0.18) 18px 22px)', opacity: 0.5 }} />
      <div style={{ position: 'absolute', right: -40, top: 0, bottom: 0, width: 32, background: 'repeating-linear-gradient(0, transparent 0 18px, rgba(200,242,58,0.18) 18px 22px)', opacity: 0.5 }} />

      <div>
        <div className="display" style={{ fontSize: 72, lineHeight: 0.9, color: 'var(--text-primary)' }}>
          NEW<br />PROJECT
        </div>
        <div style={{ marginTop: 14, color: 'var(--text-secondary)', fontSize: 14, maxWidth: 360 }}>
          Start from scratch. Your footage never leaves this machine.
        </div>
        <div style={{ marginTop: 18, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="sn-btn-primary" onClick={(e) => { e.stopPropagation(); onClick(); }}>
            <Icons.Plus size={14} stroke="#0A0A0C" /> Create project
          </button>
          <span className="sn-kbd">⌘N</span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 12 }}>or drop a file anywhere ↓</span>
        </div>
      </div>

      <div style={{ width: 200, height: 200, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ position: 'absolute', inset: 0, border: '1px solid rgba(200,242,58,0.25)', borderRadius: '50%' }} className="sn-spin-slow" />
        <div style={{ position: 'absolute', inset: 20, border: '1px dashed rgba(200,242,58,0.35)', borderRadius: '50%' }} />
        <div style={{ width: 96, height: 96, borderRadius: '50%', background: 'var(--accent-primary)', color: '#0A0A0C', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 40px rgba(200,242,58,0.4)' }}>
          <Icons.Plus size={56} sw={2} />
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={{ marginTop: 60, textAlign: 'center', color: 'var(--text-secondary)' }}>
      <div className="display" style={{ fontSize: 24, color: 'var(--text-primary)', marginBottom: 8 }}>
        Nothing yet
      </div>
      <div style={{ fontSize: 13, maxWidth: 360, margin: '0 auto 18px' }}>
        Create your first project. Snipette runs entirely on this machine — no cloud accounts, no uploads.
      </div>
      <button className="sn-btn-primary" onClick={onCreate}>
        <Icons.Plus size={14} stroke="#0A0A0C" /> Create project
      </button>
    </div>
  );
}

function RecentSection({ projects, total, filter, onFilter, onDelete }: {
  projects: Project[];
  total: number;
  filter: 'All' | '9:16' | '16:9' | '1:1';
  onFilter: (f: 'All' | '9:16' | '16:9' | '1:1') => void;
  onDelete: (id: string) => Promise<void>;
}) {
  return (
    <div style={{ marginTop: 36 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
        <span className="display" style={{ fontSize: 16, letterSpacing: '0.1em' }}>
          RECENT PROJECTS
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          {total} on this disk · sorted by recent
        </span>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg-surface)', padding: 3, borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
          {(['All', '9:16', '16:9', '1:1'] as const).map((s) => (
            <button
              key={s}
              onClick={() => onFilter(s)}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                fontWeight: 600,
                color: s === filter ? 'var(--accent-primary)' : 'var(--text-secondary)',
                background: s === filter ? 'var(--bg-hover)' : 'transparent',
                borderRadius: 6,
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 18 }}>
        {projects.map((p) => (
          <ProjectCard key={p.id} p={p} onDelete={onDelete} />
        ))}
      </div>
    </div>
  );
}

function ProjectCard({ p, onDelete }: { p: Project; onDelete: (id: string) => Promise<void> }) {
  const navigate = useNavigate();
  const openProject = useProjectStore((s) => s.openProject);
  const renameProject = useProjectStore((s) => s.renameProject);
  const duplicateProject = useProjectStore((s) => s.duplicateProject);
  const setContextMenu = useEditorStore((s) => s.setContextMenu);
  const pushToast = useEditorStore((s) => s.pushToast);
  const tone = toneFor(p.id);
  const fmtColor =
    p.format === '9:16' ? 'var(--accent-primary)' : p.format === '16:9' ? 'var(--accent-tertiary)' : 'var(--accent-secondary)';

  const handleOpen = async () => {
    await openProject(p.id);
    navigate(`/editor/${p.id}`);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Open project', hint: 'Click', onClick: () => void handleOpen() },
        { kind: 'separator' },
        {
          label: 'Rename…',
          onClick: () => {
            const next = prompt('Rename project', p.name);
            if (next && next.trim() && next !== p.name) {
              void renameProject(p.id, next.trim());
              pushToast({ kind: 'success', message: 'Renamed.' });
            }
          },
        },
        {
          label: 'Duplicate',
          onClick: async () => {
            await duplicateProject(p.id);
            pushToast({ kind: 'success', message: `Duplicated "${p.name}".` });
          },
        },
        { kind: 'separator' },
        {
          label: 'Properties',
          onClick: () =>
            pushToast({
              kind: 'info',
              message: `${p.name} · ${p.format} · ${p.width}×${p.height} · ${p.fps}fps · ${formatTime(p.duration_ms, true)}`,
            }),
        },
        { kind: 'separator' },
        {
          label: 'Delete project',
          danger: true,
          hint: 'Source media kept',
          onClick: async () => {
            if (!confirm(`Delete "${p.name}"?\n\nThe project metadata + proxies are removed. Source media on disk is untouched.`)) return;
            await onDelete(p.id);
            pushToast({ kind: 'success', message: 'Project deleted.' });
          },
        },
      ],
    });
  };

  return (
    <div
      className="sn-card"
      style={{ overflow: 'hidden', cursor: 'pointer' }}
      onClick={handleOpen}
      onContextMenu={handleContextMenu}
    >
      <div
        style={{
          position: 'relative',
          height: 180,
          background: `linear-gradient(160deg, ${tone[1]} 0%, ${tone[0]} 50%, ${tone[2]} 100%)`,
          overflow: 'hidden',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 24px, rgba(0,0,0,0.18) 24px 25px)' }} />
        <div
          style={{
            position: 'absolute',
            bottom: 10,
            left: 10,
            background: 'rgba(10,10,12,0.85)',
            backdropFilter: 'blur(8px)',
            padding: '3px 7px',
            borderRadius: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: '#fff',
          }}
        >
          {formatTime(p.duration_ms)}
        </div>
        <div
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            padding: '3px 8px',
            borderRadius: 999,
            background: 'rgba(10,10,12,0.85)',
            backdropFilter: 'blur(8px)',
            fontSize: 10,
            color: fmtColor,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: fmtColor }} />
          {p.format}
        </div>
      </div>
      <div style={{ padding: '12px 14px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {p.name}
          </div>
          <button
            className="sn-icon-btn"
            style={{ width: 22, height: 22, marginRight: -4 }}
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete project "${p.name}"? Media files on disk are untouched.`)) {
                void onDelete(p.id);
              }
            }}
            aria-label="Delete project"
          >
            <Icons.Trash size={11} />
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 10.5, color: 'var(--text-secondary)' }}>
          <Icons.Clock size={10} />
          <span>{relativeTimeAgo(p.updated_at)}</span>
          <span>·</span>
          <span className="mono">{p.fps}fps</span>
        </div>
      </div>
    </div>
  );
}

function BottomBar({ freeBytes, cacheBytes }: { freeBytes: number; cacheBytes: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 32px',
        borderTop: '1px solid var(--border-subtle)',
        fontSize: 11,
        color: 'var(--text-secondary)',
        background: 'var(--bg-surface)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent-primary)' }}>
        <Icons.Lock size={12} /> Local only — no cloud
      </span>
      <div style={{ width: 1, height: 14, background: 'var(--border-subtle)' }} />
      <span>
        Disk: <span className="mono" style={{ color: 'var(--text-primary)' }}>{fileSizeLabel(freeBytes)} free</span>
      </span>
      <div style={{ width: 1, height: 14, background: 'var(--border-subtle)' }} />
      <span>
        Cache: <span className="mono" style={{ color: 'var(--text-primary)' }}>{fileSizeLabel(cacheBytes)}</span>
      </span>
      <div style={{ flex: 1 }} />
    </div>
  );
}

// ===========================================================================================
//   PROJECTS VIEW — full grid with search + filter + sort
// ===========================================================================================

function ProjectsView({
  projects,
  total,
  filter,
  onFilter,
  onDelete,
  query,
  onQuery,
  onCreate,
}: {
  projects: Project[];
  total: number;
  filter: 'All' | '9:16' | '16:9' | '1:1';
  onFilter: (f: 'All' | '9:16' | '16:9' | '1:1') => void;
  onDelete: (id: string) => Promise<void>;
  query: string;
  onQuery: (v: string) => void;
  onCreate: () => void;
}) {
  const [sort, setSort] = useState<'recent' | 'name' | 'duration'>('recent');
  const sorted = [...projects].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'duration') return (b.duration_ms ?? 0) - (a.duration_ms ?? 0);
    return b.updated_at - a.updated_at;
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <span className="display" style={{ fontSize: 16, letterSpacing: '0.1em' }}>
          ALL PROJECTS
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{total} on this disk</span>
        <div style={{ flex: 1 }} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 999,
            width: 240,
          }}
        >
          <Icons.Search size={12} stroke="var(--text-secondary)" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search projects…"
            style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)' }}
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 11,
            color: 'var(--text-primary)',
          }}
        >
          <option value="recent">Recent</option>
          <option value="name">Name (A–Z)</option>
          <option value="duration">Duration</option>
        </select>
        <button className="sn-btn-primary" onClick={onCreate} style={{ padding: '7px 12px' }}>
          <Icons.Plus size={12} stroke="#0A0A0C" /> New project
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {(['All', '9:16', '16:9', '1:1'] as const).map((s) => (
          <button
            key={s}
            onClick={() => onFilter(s)}
            style={{
              padding: '5px 12px',
              fontSize: 11,
              fontWeight: 600,
              borderRadius: 999,
              color: s === filter ? 'var(--accent-primary)' : 'var(--text-secondary)',
              background: s === filter ? 'rgba(200,242,58,0.10)' : 'var(--bg-surface)',
              border: `1px solid ${s === filter ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {sorted.length === 0 ? (
        <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
          <Icons.Folder size={32} stroke="var(--text-muted)" />
          <div style={{ marginTop: 12, fontSize: 13 }}>No projects match the current filter.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 18 }}>
          {sorted.map((p) => (
            <ProjectCard key={p.id} p={p} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

// ===========================================================================================
//   TEMPLATES VIEW — starter project presets
// ===========================================================================================

interface TemplateDef {
  id: string;
  name: string;
  description: string;
  format: Format;
  width: number;
  height: number;
  fps: number;
  tag?: string;
  tone: keyof typeof TONES;
}

const TEMPLATES: TemplateDef[] = [
  {
    id: 'tiktok-vlog',
    name: 'TikTok Vlog',
    description: 'Vertical 1080×1920 · 30fps, ideal for talking-head shorts.',
    format: '9:16',
    width: 1080,
    height: 1920,
    fps: 30,
    tag: 'Most used',
    tone: 'warm',
  },
  {
    id: 'reels-product',
    name: 'Reels Product Demo',
    description: 'Vertical 1080×1920 · 30fps, fast-cut product showcase.',
    format: '9:16',
    width: 1080,
    height: 1920,
    fps: 30,
    tone: 'pink',
  },
  {
    id: 'shorts-60',
    name: 'YouTube Shorts (60fps)',
    description: 'Vertical 1080×1920 · 60fps for smooth gameplay or motion.',
    format: '9:16',
    width: 1080,
    height: 1920,
    fps: 60,
    tone: 'red',
  },
  {
    id: 'youtube-tutorial',
    name: 'YouTube Tutorial',
    description: '1920×1080 · 30fps wide format for long-form content.',
    format: '16:9',
    width: 1920,
    height: 1080,
    fps: 30,
    tone: 'blue',
  },
  {
    id: 'youtube-cinematic',
    name: 'YouTube Cinematic',
    description: '1920×1080 · 24fps for film-feel storytelling.',
    format: '16:9',
    width: 1920,
    height: 1080,
    fps: 24,
    tone: 'mono',
  },
  {
    id: 'ig-feed',
    name: 'Instagram Feed',
    description: '1080×1080 · 30fps square for in-feed posts.',
    format: '1:1',
    width: 1080,
    height: 1080,
    fps: 30,
    tone: 'amber',
  },
];

function TemplatesView({ onCreate }: { onCreate: () => void }) {
  const navigate = useNavigate();
  const createProject = useProjectStore((s) => s.createProject);
  const openProject = useProjectStore((s) => s.openProject);
  const pushToast = useEditorStore((s) => s.pushToast);

  const useTemplate = async (t: TemplateDef) => {
    try {
      const project = await createProject({
        name: t.name,
        format: t.format,
        width: t.width,
        height: t.height,
        fps: t.fps,
      });
      await openProject(project.id);
      pushToast({ kind: 'success', message: `Created "${t.name}" from template.` });
      navigate(`/editor/${project.id}`);
    } catch (e) {
      pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Template creation failed.' });
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <span className="display" style={{ fontSize: 16, letterSpacing: '0.1em' }}>
          STARTER TEMPLATES
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          One-click project setups · {TEMPLATES.length} available
        </span>
        <div style={{ flex: 1 }} />
        <button className="sn-btn-ghost" onClick={onCreate} style={{ padding: '6px 12px' }}>
          <Icons.Plus size={12} /> Custom
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 18 }}>
        {TEMPLATES.map((t) => {
          const tone = TONES[t.tone];
          const fmtColor =
            t.format === '9:16' ? 'var(--accent-primary)' : t.format === '16:9' ? 'var(--accent-tertiary)' : 'var(--accent-secondary)';
          return (
            <div key={t.id} className="sn-card" style={{ overflow: 'hidden', cursor: 'pointer' }} onClick={() => useTemplate(t)}>
              <div
                style={{
                  height: 140,
                  background: `linear-gradient(160deg, ${tone[1]} 0%, ${tone[0]} 50%, ${tone[2]} 100%)`,
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <div
                  className="display"
                  style={{ fontSize: 36, letterSpacing: '0.04em', color: '#fff', opacity: 0.85, textShadow: '0 4px 10px rgba(0,0,0,0.35)' }}
                >
                  {t.format}
                </div>
                {t.tag && (
                  <span
                    style={{
                      position: 'absolute',
                      top: 10,
                      left: 10,
                      padding: '3px 7px',
                      background: 'var(--accent-primary)',
                      color: '#0A0A0C',
                      fontSize: 9,
                      fontWeight: 700,
                      borderRadius: 3,
                      letterSpacing: 0.5,
                    }}
                  >
                    {t.tag.toUpperCase()}
                  </span>
                )}
                <span
                  style={{
                    position: 'absolute',
                    top: 10,
                    right: 10,
                    padding: '3px 8px',
                    borderRadius: 999,
                    background: 'rgba(10,10,12,0.85)',
                    backdropFilter: 'blur(8px)',
                    fontSize: 10,
                    color: fmtColor,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: fmtColor }} />
                  {t.fps}fps
                </span>
              </div>
              <div style={{ padding: '12px 14px 14px' }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{t.name}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.4 }}>
                  {t.description}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===========================================================================================
//   EXPORT QUEUE VIEW — live jobs subscribing to export progress events
// ===========================================================================================

interface ExportJobRow {
  jobId: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  stage: string;
  outputPath: string;
  fileSizeBytes?: number;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

function ExportQueueView() {
  const [jobs, setJobs] = useState<Map<string, ExportJobRow>>(new Map());
  const pushToast = useEditorStore((s) => s.pushToast);

  useEffect(() => {
    const offProgress = window.snipette.export.onProgress((p) => {
      setJobs((m) => {
        const next = new Map(m);
        const existing = next.get(p.jobId);
        next.set(p.jobId, {
          jobId: p.jobId,
          status: 'running',
          progress: p.percent,
          stage: p.stage,
          outputPath: existing?.outputPath ?? '',
          startedAt: existing?.startedAt ?? Date.now(),
        });
        return next;
      });
    });
    const offComplete = window.snipette.export.onComplete((p) => {
      setJobs((m) => {
        const next = new Map(m);
        const existing = next.get(p.jobId);
        next.set(p.jobId, {
          jobId: p.jobId,
          status: 'done',
          progress: 100,
          stage: 'Complete',
          outputPath: p.outputPath,
          fileSizeBytes: p.fileSizeBytes,
          startedAt: existing?.startedAt ?? Date.now(),
          completedAt: Date.now(),
        });
        return next;
      });
    });
    const offError = window.snipette.export.onError((p) => {
      setJobs((m) => {
        const next = new Map(m);
        const existing = next.get(p.jobId);
        next.set(p.jobId, {
          jobId: p.jobId,
          status: 'error',
          progress: existing?.progress ?? 0,
          stage: 'Failed',
          outputPath: existing?.outputPath ?? '',
          error: p.error,
          startedAt: existing?.startedAt ?? Date.now(),
          completedAt: Date.now(),
        });
        return next;
      });
    });
    return () => {
      offProgress();
      offComplete();
      offError();
    };
  }, []);

  const list = Array.from(jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
  const running = list.filter((j) => j.status === 'running');

  const cancel = async (jobId: string) => {
    try {
      await window.snipette.export.cancel(jobId);
      pushToast({ kind: 'info', message: 'Export cancelled.' });
    } catch (e) {
      pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Cancel failed.' });
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18 }}>
        <span className="display" style={{ fontSize: 16, letterSpacing: '0.1em' }}>
          EXPORT QUEUE
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          {running.length} running · {list.length} total this session
        </span>
      </div>

      {list.length === 0 ? (
        <div style={{ marginTop: 60, textAlign: 'center', color: 'var(--text-muted)' }}>
          <Icons.Upload size={32} stroke="var(--text-muted)" />
          <div className="display" style={{ fontSize: 18, marginTop: 12 }}>
            No exports yet
          </div>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            Open a project and press ⌘E to export. Active and completed jobs will appear here.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((j) => (
            <div
              key={j.jobId}
              className="sn-card"
              style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14 }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background:
                        j.status === 'running'
                          ? 'var(--accent-primary)'
                          : j.status === 'done'
                            ? 'var(--accent-tertiary)'
                            : j.status === 'error'
                              ? 'var(--red-alert)'
                              : 'var(--text-muted)',
                      boxShadow:
                        j.status === 'running'
                          ? '0 0 8px var(--accent-primary)'
                          : 'none',
                    }}
                  />
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {j.stage}
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                    · started {relativeTimeAgo(j.startedAt)}
                  </span>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    marginTop: 4,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={j.outputPath || '(output path pending)'}
                >
                  {j.outputPath || '(output path pending)'}
                </div>
                {j.error && (
                  <div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--red-alert)' }}>
                    {j.error}
                  </div>
                )}
                <div
                  style={{
                    height: 4,
                    background: 'var(--bg-elevated)',
                    borderRadius: 4,
                    marginTop: 8,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max(2, Math.min(100, j.progress))}%`,
                      height: '100%',
                      background:
                        j.status === 'error'
                          ? 'var(--red-alert)'
                          : j.status === 'done'
                            ? 'var(--accent-tertiary)'
                            : 'var(--accent-primary)',
                      transition: 'width .25s',
                    }}
                  />
                </div>
              </div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 48, textAlign: 'right' }}>
                {Math.round(j.progress)}%
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {j.status === 'running' && (
                  <button className="sn-btn-danger" onClick={() => cancel(j.jobId)} style={{ padding: '6px 10px', fontSize: 11 }}>
                    Cancel
                  </button>
                )}
                {j.status === 'done' && j.outputPath && (
                  <button
                    className="sn-btn-ghost"
                    onClick={() => window.snipette.system.openInFinder(j.outputPath)}
                    style={{ padding: '6px 10px', fontSize: 11 }}
                  >
                    <Icons.Folder size={11} /> Reveal
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
