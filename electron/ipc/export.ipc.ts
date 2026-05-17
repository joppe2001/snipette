import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import log from 'electron-log';
import { CH } from '../../shared/types';
import type {
  Clip,
  ExportOpts,
  ExportStage,
  ExportStatus,
  MediaAsset,
  Project,
  Track,
  Transition,
} from '../../shared/types';
import { getDb } from '../services/db.service';
import { parseFFmpegProgress, spawnFFmpeg } from '../services/ffmpeg.service';
import { buildExportGraph } from '../services/filter-graph';
import { buildEncoderArgs, type HwAccelMode } from '../services/encoder';

interface Job extends ExportStatus {
  cancel?: () => void;
}

/**
 * The new advanced export fields aren't on the canonical {@link ExportOpts} interface yet;
 * they ride along as optional properties until shared/types.ts is updated.
 */
interface AdvancedExportOpts extends ExportOpts {
  target_bitrate?: number;
  two_pass?: boolean;
  hw_accel?: HwAccelMode;
  normalize_loudness?: boolean;
  profile?: 'baseline' | 'main' | 'high';
  level?: string;
  pixel_format?: 'yuv420p' | 'yuv420p10le';
}

const jobs = new Map<string, Job>();

/**
 * Schedule removal of a terminal-state job from the in-memory `jobs` map. The renderer
 * gets a 60-second window to query final status after completion/error/cancel — after
 * that the entry is dropped so a long-running session that exports many times doesn't
 * leak Job objects (each holds output_path strings + ffmpeg cancel closures).
 */
const JOB_RETENTION_MS = 60_000;
function scheduleJobCleanup(jobId: string): void {
  setTimeout(() => {
    jobs.delete(jobId);
  }, JOB_RETENTION_MS).unref?.();
}

function send(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

export function registerExportHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CH.exportStart, async (_e, opts: ExportOpts): Promise<string> => {
    const jobId = uuid();
    const job: Job = {
      job_id: jobId,
      project_id: opts.project_id,
      status: 'queued',
      progress: 0,
      stage_label: 'Queued',
      output_path: opts.output_path,
      started_at: Date.now(),
      completed_at: null,
      error: null,
    };
    jobs.set(jobId, job);

    runExport(jobId, opts, getWindow)
      .catch((err) => {
        const j = jobs.get(jobId);
        if (j) {
          j.status = 'error';
          j.error = err instanceof Error ? err.message : String(err);
          j.completed_at = Date.now();
          send(getWindow(), CH.exportErrorEvent, { jobId, error: j.error });
        }
      })
      .finally(() => {
        scheduleJobCleanup(jobId);
      });

    return jobId;
  });

  ipcMain.handle(CH.exportCancel, async (_e, jobId: string): Promise<void> => {
    const j = jobs.get(jobId);
    if (j?.cancel) {
      j.cancel();
      j.status = 'cancelled';
      j.completed_at = Date.now();
      scheduleJobCleanup(jobId);
    }
  });

  ipcMain.handle(CH.exportStatus, async (_e, jobId: string): Promise<ExportStatus> => {
    const j = jobs.get(jobId);
    if (!j) throw new Error(`Job ${jobId} not found`);
    return j;
  });
}

async function runExport(
  jobId: string,
  opts: ExportOpts,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const job = jobs.get(jobId)!;
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(opts.project_id) as
    | Project
    | undefined;
  if (!project) throw new Error('Project not found');

  const tracks = db.prepare('SELECT * FROM tracks WHERE project_id = ? ORDER BY order_index').all(
    project.id,
  ) as Track[];
  const clips = db.prepare('SELECT * FROM clips WHERE project_id = ? ORDER BY start_time_ms').all(
    project.id,
  ) as Clip[];
  const transitions = db.prepare('SELECT * FROM transitions WHERE project_id = ?').all(
    project.id,
  ) as Transition[];

  const assets = db.prepare('SELECT * FROM media_assets WHERE project_id = ?').all(
    project.id,
  ) as MediaAsset[];
  const assetPaths = new Map<string, string>(
    assets.map((a) => [a.id, a.proxy_path && fs.existsSync(a.proxy_path) ? a.proxy_path : a.original_path]),
  );

  setStage(job, getWindow, 'preparing', 0, 'Preparing graph');

  // Override project dimensions with export opts.
  const graph = buildExportGraph({
    project: {
      width: opts.width,
      height: opts.height,
      fps: opts.fps,
      duration_ms: project.duration_ms || clips.reduce((m, c) => Math.max(m, c.start_time_ms + c.duration_ms), 0),
    },
    tracks,
    clips,
    transitions,
    assetPaths,
  });

  ensureDir(path.dirname(opts.output_path));

  const totalDurationS = Math.max(
    0.1,
    (project.duration_ms || clips.reduce((m, c) => Math.max(m, c.start_time_ms + c.duration_ms), 0)) / 1000,
  );

  // Build the shared input + filter graph prefix once — the same args lead pass 1 and pass 2.
  const graphPrefix: string[] = ['-y', ...graph.inputs];
  graphPrefix.push('-filter_complex', graph.filterComplex);
  graphPrefix.push('-map', `[${graph.videoOutLabel}]`);
  if (graph.hasAudio && opts.include_audio && graph.audioOutLabel) {
    graphPrefix.push('-map', `[${graph.audioOutLabel}]`);
  }

  const advanced = opts as AdvancedExportOpts;
  const built = buildEncoderArgs(
    {
      format: opts.format,
      quality: opts.quality,
      targetBitrate: advanced.target_bitrate,
      twoPass: advanced.two_pass,
      hwAccel: advanced.hw_accel,
      normalizeLoudness: advanced.normalize_loudness,
      profile: advanced.profile,
      level: advanced.level,
      pixelFormat: advanced.pixel_format,
      fps: opts.fps,
      includeAudio: opts.include_audio,
    },
    totalDurationS,
    opts.include_audio,
  );

  setStage(job, getWindow, 'encoding', 0, 'Encoding video');

  if (built.twoPassCmd) {
    // Pass 1: progress maps to 0-50%.
    const pass1Args = [...graphPrefix, ...built.twoPassCmd.pass1];
    const pass1 = spawnFFmpeg(pass1Args, (line) => {
      const t = parseFFmpegProgress(line);
      if (t != null) {
        const pct = Math.min(49, Math.max(0, (t / totalDurationS) * 50));
        job.progress = pct;
        send(getWindow(), CH.exportProgressEvent, {
          jobId,
          percent: pct,
          stage: 'Encoding video (pass 1/2)',
          etaSeconds: Math.max(0, totalDurationS - t),
        });
      }
    });
    job.cancel = () => pass1.process.kill('SIGTERM');

    try {
      await pass1.done;
    } catch (e) {
      if (job.status === 'cancelled') {
        try {
          if (fs.existsSync(opts.output_path)) fs.unlinkSync(opts.output_path);
        } catch {
          // ignore
        }
        return;
      }
      throw e;
    }

    // Pass 2: progress maps to 50-99%.
    const pass2Args = [...graphPrefix, ...built.twoPassCmd.pass2, opts.output_path];
    const pass2 = spawnFFmpeg(pass2Args, (line) => {
      const t = parseFFmpegProgress(line);
      if (t != null) {
        const pct = Math.min(99, Math.max(50, 50 + (t / totalDurationS) * 49));
        job.progress = pct;
        send(getWindow(), CH.exportProgressEvent, {
          jobId,
          percent: pct,
          stage: 'Encoding video (pass 2/2)',
          etaSeconds: Math.max(0, totalDurationS - t),
        });
      }
    });
    job.cancel = () => pass2.process.kill('SIGTERM');

    try {
      await pass2.done;
    } catch (e) {
      if (job.status === 'cancelled') {
        try {
          if (fs.existsSync(opts.output_path)) fs.unlinkSync(opts.output_path);
        } catch {
          // ignore
        }
        return;
      }
      throw e;
    }
  } else {
    const args: string[] = [...graphPrefix, ...built.args, opts.output_path];

    const run = spawnFFmpeg(args, (line) => {
      const t = parseFFmpegProgress(line);
      if (t != null) {
        const pct = Math.min(99, Math.max(0, (t / totalDurationS) * 100));
        job.progress = pct;
        send(getWindow(), CH.exportProgressEvent, {
          jobId,
          percent: pct,
          stage: stageLabel(job.status),
          etaSeconds: Math.max(0, totalDurationS - t),
        });
      }
    });

    job.cancel = () => run.process.kill('SIGTERM');

    try {
      await run.done;
    } catch (e) {
      if (job.status === 'cancelled') {
        try {
          if (fs.existsSync(opts.output_path)) fs.unlinkSync(opts.output_path);
        } catch {
          // ignore
        }
        return;
      }
      throw e;
    }
  }

  if (!fs.existsSync(opts.output_path)) {
    throw new Error('Export produced no file (ffmpeg ended cleanly but the file is missing)');
  }

  const size = fs.statSync(opts.output_path).size;
  setStage(job, getWindow, 'done', 100, 'Complete');
  job.completed_at = Date.now();
  send(getWindow(), CH.exportCompleteEvent, {
    jobId,
    outputPath: opts.output_path,
    fileSizeBytes: size,
  });
  log.info(`[export] ${jobId} done → ${opts.output_path} (${size} bytes)`);
}

function setStage(
  job: Job,
  getWindow: () => BrowserWindow | null,
  stage: ExportStage,
  progress: number,
  label: string,
): void {
  job.status = stage;
  job.progress = progress;
  job.stage_label = label;
  send(getWindow(), CH.exportProgressEvent, {
    jobId: job.job_id,
    percent: progress,
    stage: label,
    etaSeconds: 0,
  });
}

function stageLabel(stage: ExportStage): string {
  switch (stage) {
    case 'preparing':
      return 'Preparing graph';
    case 'encoding':
      return 'Encoding video';
    case 'mixing-audio':
      return 'Mixing audio';
    case 'writing-file':
      return 'Writing file';
    case 'done':
      return 'Complete';
    default:
      return stage;
  }
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
