import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import log from 'electron-log';
import { getDb } from './db.service';
import type { Clip, MediaAsset, Project, Track, Transition } from '../../shared/types';

export interface Snapshot {
  projectId: string;
  timestamp: number;
  path: string;
  sizeBytes: number;
}

export interface ExportBundleResult {
  ok: boolean;
  sizeBytes: number;
}

const MAX_SNAPSHOTS = 20;

function snapshotsDir(projectId: string): string {
  const dir = path.join(app.getPath('userData'), 'snapshots', projectId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dbPath(): string {
  return path.join(app.getPath('userData'), 'projects', 'snipette.db');
}

/**
 * Create a timestamped copy of the active SQLite database for the given project.
 * Snapshots are stored per-project in `<userData>/snapshots/<projectId>/<ts>.db`.
 * The oldest snapshots beyond MAX_SNAPSHOTS are pruned automatically.
 */
export function createSnapshot(projectId: string): Snapshot {
  if (!projectId) throw new Error('projectId is required');
  const source = dbPath();
  if (!fs.existsSync(source)) throw new Error('Database not found');
  const ts = Date.now();
  const out = path.join(snapshotsDir(projectId), `${ts}.db`);
  // better-sqlite3 uses WAL journal mode — a plain copy is generally safe between user
  // actions, and we accept the small risk because snapshot operations happen frequently
  // and synchronously. The pre-restore safety copy in restoreSnapshot also covers us.
  try {
    fs.copyFileSync(source, out);
  } catch (e) {
    log.error('[backup] snapshot copy failed', e);
    throw e instanceof Error ? e : new Error(String(e));
  }
  const stat = fs.statSync(out);
  pruneOldSnapshots(projectId, MAX_SNAPSHOTS);
  log.info(`[backup] snapshot created: ${out} (${stat.size} bytes)`);
  return { projectId, timestamp: ts, path: out, sizeBytes: stat.size };
}

/** Return the snapshot list for a project, newest first. */
export function listSnapshots(projectId: string): Snapshot[] {
  if (!projectId) return [];
  const dir = snapshotsDir(projectId);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
  const out: Snapshot[] = [];
  for (const f of entries) {
    const filePath = path.join(dir, f);
    const ts = parseInt(f.replace('.db', ''), 10);
    if (!Number.isFinite(ts)) continue;
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      continue;
    }
    out.push({ projectId, timestamp: ts, path: filePath, sizeBytes: size });
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

/** Delete snapshots beyond the keepCount, oldest first. */
export function pruneOldSnapshots(projectId: string, keepCount: number): void {
  const all = listSnapshots(projectId);
  for (let i = keepCount; i < all.length; i++) {
    try {
      fs.unlinkSync(all[i].path);
    } catch (e) {
      log.warn('[backup] prune failed for', all[i].path, e);
    }
  }
}

/**
 * Restore a snapshot file to the active database location.
 * IMPORTANT: caller must close the database BEFORE invoking and reopen it AFTER.
 * The current DB is first copied to `<dbPath>.pre-restore-<ts>.db` so the action is undoable.
 */
export async function restoreSnapshot(snapshotPath: string): Promise<void> {
  if (!snapshotPath) throw new Error('snapshotPath is required');
  if (!fs.existsSync(snapshotPath)) throw new Error('Snapshot not found');
  const target = dbPath();
  if (fs.existsSync(target)) {
    const preRestore = `${target}.pre-restore-${Date.now()}.db`;
    try {
      fs.copyFileSync(target, preRestore);
    } catch (e) {
      log.warn('[backup] pre-restore backup failed', e);
    }
  }
  fs.copyFileSync(snapshotPath, target);
  log.info(`[backup] restored snapshot ${snapshotPath} -> ${target}`);
}

interface BundlePayload {
  project: Project | undefined;
  tracks: Track[];
  clips: Clip[];
  transitions: Transition[];
  assets: MediaAsset[];
}

interface BundleManifest {
  snipetteVersion: number;
  exportedAt: number;
  projectId: string;
}

/**
 * Export a project as a self-contained `.snip` bundle (tar+gzip).
 *
 * Layout inside the archive:
 *   manifest.json    – metadata
 *   project.json     – project + related rows from SQLite as JSON
 *   media/<id>.<ext> – copy of each media asset's original file
 */
export async function exportBundle(
  projectId: string,
  outputPath: string,
): Promise<ExportBundleResult> {
  if (!projectId) throw new Error('projectId is required');
  if (!outputPath) throw new Error('outputPath is required');

  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | Project
    | undefined;
  if (!project) throw new Error(`Project ${projectId} not found`);

  const tracks = db.prepare('SELECT * FROM tracks WHERE project_id = ?').all(projectId) as Track[];
  const clips = db.prepare('SELECT * FROM clips WHERE project_id = ?').all(projectId) as Clip[];
  const transitions = db
    .prepare('SELECT * FROM transitions WHERE project_id = ?')
    .all(projectId) as Transition[];
  const assets = db
    .prepare('SELECT * FROM media_assets WHERE project_id = ?')
    .all(projectId) as MediaAsset[];

  const tmpRoot = path.join(app.getPath('temp'), `snipette-bundle-${Date.now()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  const mediaDir = path.join(tmpRoot, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  try {
    const manifest: BundleManifest = {
      snipetteVersion: 1,
      exportedAt: Date.now(),
      projectId,
    };
    fs.writeFileSync(
      path.join(tmpRoot, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );

    const payload: BundlePayload = { project, tracks, clips, transitions, assets };
    fs.writeFileSync(
      path.join(tmpRoot, 'project.json'),
      JSON.stringify(payload, null, 2),
      'utf8',
    );

    for (const a of assets) {
      if (!a.original_path || !fs.existsSync(a.original_path)) {
        log.warn(`[backup] missing media: ${a.original_path}`);
        continue;
      }
      const ext = path.extname(a.original_path);
      try {
        fs.copyFileSync(a.original_path, path.join(mediaDir, `${a.id}${ext}`));
      } catch (e) {
        log.warn(`[backup] failed to copy media ${a.original_path}`, e);
      }
    }

    await runTar(['-czf', outputPath, '-C', tmpRoot, '.']);
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (e) {
      log.warn('[backup] failed to clean up staging dir', e);
    }
  }

  const stat = fs.statSync(outputPath);
  log.info(`[backup] bundle exported: ${outputPath} (${stat.size} bytes)`);
  return { ok: true, sizeBytes: stat.size };
}

function runTar(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('tar', args);
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed (exit ${code}): ${stderr.slice(-500)}`));
    });
  });
}
