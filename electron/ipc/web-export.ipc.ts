/**
 * IPC handlers for the WebCodecs/canvas export path. The renderer encodes video to a
 * Uint8Array via mp4-muxer and asks us to (a) produce an audio-only file via FFmpeg and
 * (b) mux the audio into the video to produce the final output.
 *
 * Why split the work this way:
 *   - WebCodecs's `AudioEncoder` exists but the ecosystem is thin; FFmpeg's amix + audio FX
 *     chain is mature and handles ducking, loudnorm, and per-clip effects.
 *   - mp4-muxer can run with audio chunks fed in, but feeding it requires re-decoding the
 *     FFmpeg-produced audio file in JS. Doing a final `ffmpeg -c copy` mux in main is
 *     simpler and just as fast — no re-encode involved.
 */

import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuid } from 'uuid';
import log from 'electron-log';
import { CH } from '../../shared/types';
import type {
  Clip,
  MediaAsset,
  Track,
  WebExportAudioOpts,
  WebExportMuxOpts,
  WebExportMuxResult,
} from '../../shared/types';
import { getDb } from '../services/db.service';
import { parseFFmpegProgress, spawnFFmpeg } from '../services/ffmpeg.service';
import { buildAudioOnlyGraph } from '../services/audio-graph';

interface ActiveJob {
  /** Kill the underlying FFmpeg process (if any). */
  cancel?: () => void;
}

const activeJobs = new Map<string, ActiveJob>();

function tempPath(suffix: string): string {
  return path.join(os.tmpdir(), `snipette-web-${uuid()}${suffix}`);
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export function registerWebExportHandlers(getWindow: () => BrowserWindow | null): void {
  void getWindow;

  ipcMain.handle(
    CH.webExportRenderAudio,
    async (_e, opts: WebExportAudioOpts): Promise<string | null> => {
      const db = getDb();
      const tracks = db
        .prepare('SELECT * FROM tracks WHERE project_id = ? ORDER BY order_index')
        .all(opts.project_id) as Track[];
      const clips = db
        .prepare('SELECT * FROM clips WHERE project_id = ? ORDER BY start_time_ms')
        .all(opts.project_id) as Clip[];
      const assets = db
        .prepare('SELECT * FROM media_assets WHERE project_id = ?')
        .all(opts.project_id) as MediaAsset[];

      const assetPaths = new Map<string, string>(
        assets.map((a) => [
          a.id,
          a.proxy_path && fs.existsSync(a.proxy_path) ? a.proxy_path : a.original_path,
        ]),
      );

      const graph = buildAudioOnlyGraph({
        tracks,
        clips,
        assetPaths,
        normalizeLoudness: !!opts.normalize_loudness,
      });
      if (!graph) return null;

      const outPath = tempPath('.m4a');
      const args: string[] = [
        '-y',
        ...graph.inputs,
        '-filter_complex',
        graph.filterComplex,
        '-map',
        `[${graph.audioOutLabel}]`,
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        outPath,
      ];

      const jobKey = `audio:${opts.project_id}`;
      const run = spawnFFmpeg(args, (line) => {
        // Surface progress to logs but don't send to renderer here — the orchestrator's
        // per-frame loop already drives the user-visible progress bar. Audio render is
        // typically a small fraction of total time.
        const t = parseFFmpegProgress(line);
        if (t != null) log.debug(`[webExport audio] t=${t.toFixed(2)}s`);
      });
      activeJobs.set(jobKey, { cancel: () => run.process.kill('SIGTERM') });

      try {
        await run.done;
      } finally {
        activeJobs.delete(jobKey);
      }

      if (!fs.existsSync(outPath)) {
        throw new Error('Audio render produced no file');
      }
      return outPath;
    },
  );

  ipcMain.handle(
    CH.webExportMuxFinal,
    async (_e, opts: WebExportMuxOpts): Promise<WebExportMuxResult> => {
      ensureDir(path.dirname(opts.output_path));
      const tempVideo = tempPath('.mp4');

      // Persist the encoded video to disk so FFmpeg can mux it in. Using fs.writeFile
      // avoids holding the entire buffer in memory longer than needed.
      const buf = Buffer.from(opts.video_buffer);
      await fs.promises.writeFile(tempVideo, buf);

      try {
        if (opts.audio_path && fs.existsSync(opts.audio_path)) {
          const args: string[] = [
            '-y',
            '-i',
            tempVideo,
            '-i',
            opts.audio_path,
            '-c',
            'copy',
            '-map',
            '0:v:0',
            '-map',
            '1:a:0',
            '-shortest',
            '-movflags',
            '+faststart',
            opts.output_path,
          ];
          const jobKey = `mux:${opts.output_path}`;
          const run = spawnFFmpeg(args);
          activeJobs.set(jobKey, { cancel: () => run.process.kill('SIGTERM') });
          try {
            await run.done;
          } finally {
            activeJobs.delete(jobKey);
          }
        } else {
          // No audio — just move the temp file into the final location.
          await fs.promises.rename(tempVideo, opts.output_path);
        }
      } finally {
        if (fs.existsSync(tempVideo)) {
          try {
            await fs.promises.unlink(tempVideo);
          } catch {
            // ignore — leftover temp files are harmless
          }
        }
        if (opts.audio_path && fs.existsSync(opts.audio_path)) {
          try {
            await fs.promises.unlink(opts.audio_path);
          } catch {
            // ignore
          }
        }
      }

      if (!fs.existsSync(opts.output_path)) {
        throw new Error('Mux produced no file');
      }
      const size = fs.statSync(opts.output_path).size;
      log.info(`[webExport] done → ${opts.output_path} (${size} bytes)`);
      return { output_path: opts.output_path, file_size_bytes: size };
    },
  );

  ipcMain.handle(CH.webExportCancel, async (_e, projectId: string): Promise<void> => {
    for (const [key, job] of activeJobs) {
      if (key.endsWith(`:${projectId}`) || key.startsWith('mux:')) {
        job.cancel?.();
        activeJobs.delete(key);
      }
    }
  });
}
