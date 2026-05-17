import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icons } from '@/components/ui/icons';
import { useEditorStore } from '@/store/editor.store';
import { useProjectStore } from '@/store/project.store';
import { fileSizeLabel } from '@/utils/file';

interface SnapshotRow {
  projectId: string;
  timestamp: number;
  path: string;
  sizeBytes: number;
}

function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function BackupModal(): JSX.Element {
  const project = useProjectStore((s) => s.activeProject);
  const pushToast = useEditorStore((s) => s.pushToast);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [now, setNow] = useState<number>(Date.now());
  const [busy, setBusy] = useState<'snapshot' | 'export' | 'restore' | null>(null);
  const [confirmRestorePath, setConfirmRestorePath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!project) {
      setSnapshots([]);
      return;
    }
    try {
      const list = await window.snipette.backup.listSnapshots(project.id);
      setSnapshots(list);
    } catch (e) {
      pushToast({ kind: 'error', message: `Could not load snapshots: ${(e as Error).message}` });
    }
  }, [project, pushToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Tick the clock so relative times stay fresh while the modal is open.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const onSnapshotNow = useCallback(async () => {
    if (!project || busy) return;
    setBusy('snapshot');
    try {
      await window.snipette.backup.createSnapshot(project.id);
      await refresh();
      pushToast({ kind: 'success', message: 'Snapshot saved.' });
    } catch (e) {
      pushToast({ kind: 'error', message: `Snapshot failed: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }, [project, busy, refresh, pushToast]);

  const onExportBundle = useCallback(async () => {
    if (!project || busy) return;
    setBusy('export');
    try {
      const safeName = project.name.replace(/[^a-z0-9_\- ]/gi, '_').trim() || 'project';
      const picked = await window.snipette.system.showFilePicker({
        title: 'Export project bundle',
        save: true,
        defaultFileName: `${safeName}.snip`,
        filters: [{ name: 'Snipette bundle', extensions: ['snip'] }],
      });
      if (!picked.length) {
        setBusy(null);
        return;
      }
      const target = picked[0];
      const result = await window.snipette.backup.exportBundle(project.id, target);
      pushToast({
        kind: 'success',
        message: `Bundle exported (${fileSizeLabel(result.sizeBytes)})`,
      });
    } catch (e) {
      pushToast({ kind: 'error', message: `Bundle export failed: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }, [project, busy, pushToast]);

  const onConfirmRestore = useCallback(async () => {
    if (!confirmRestorePath || busy) return;
    setBusy('restore');
    try {
      await window.snipette.backup.restoreSnapshot(confirmRestorePath);
      pushToast({
        kind: 'success',
        message: 'Snapshot restored. Reloading editor…',
      });
      setConfirmRestorePath(null);
      // After a DB swap the in-memory state in the renderer is stale — a full reload
      // is the simplest way to guarantee consistency.
      window.setTimeout(() => window.location.reload(), 500);
    } catch (e) {
      pushToast({ kind: 'error', message: `Restore failed: ${(e as Error).message}` });
      setBusy(null);
    }
  }, [confirmRestorePath, busy, pushToast]);

  if (!project) {
    return (
      <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
        Open a project to manage backups and bundles.
      </div>
    );
  }

  const lastSnapshot = snapshots[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section
        style={{
          padding: 14,
          background: 'var(--bg-base)',
          borderRadius: 8,
          border: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{project.name}</div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          {project.id}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
          Last snapshot:{' '}
          {lastSnapshot
            ? `${relativeTime(lastSnapshot.timestamp, now)} · ${fileSizeLabel(lastSnapshot.sizeBytes)}`
            : 'none yet'}
        </div>
      </section>

      <section style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={onSnapshotNow} disabled={busy !== null}>
          {busy === 'snapshot' ? 'Saving…' : 'Snapshot now'}
        </Button>
        <Button onClick={onExportBundle} disabled={busy !== null}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icons.Download size={12} />
            {busy === 'export' ? 'Exporting…' : 'Export bundle (.snip)'}
          </span>
        </Button>
      </section>

      <section>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600 }}>Snapshots</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {snapshots.length} stored · keeps last 20
          </div>
        </div>

        {snapshots.length === 0 ? (
          <div
            style={{
              padding: 18,
              fontSize: 11,
              color: 'var(--text-muted)',
              border: '1px dashed var(--border-subtle)',
              borderRadius: 8,
              textAlign: 'center',
            }}
          >
            No snapshots yet. Click <strong>Snapshot now</strong> to make one.
          </div>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              maxHeight: 240,
              overflowY: 'auto',
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
            }}
          >
            {snapshots.map((s, idx) => (
              <li
                key={s.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderBottom:
                    idx === snapshots.length - 1 ? 'none' : '1px solid var(--border-subtle)',
                  gap: 12,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>
                    {formatTimestamp(s.timestamp)}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    {relativeTime(s.timestamp, now)} · {fileSizeLabel(s.sizeBytes)}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  onClick={() => setConfirmRestorePath(s.path)}
                  disabled={busy !== null}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirmRestorePath && (
        <div
          style={{
            padding: 14,
            background: 'var(--bg-base)',
            borderRadius: 8,
            border: '1px solid var(--accent-primary)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600 }}>Restore this snapshot?</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            All projects in this Snipette database will be replaced with the snapshot contents. A
            safety copy of the current database is written first. The editor will reload.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="danger" onClick={onConfirmRestore} disabled={busy !== null}>
              {busy === 'restore' ? 'Restoring…' : 'Restore'}
            </Button>
            <Button onClick={() => setConfirmRestorePath(null)} disabled={busy !== null}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
