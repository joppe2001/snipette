/**
 * Voice studio IPC: receives a `MediaRecorder`-encoded buffer from the renderer, writes
 * it to the project's media folder, and registers a `MediaAsset` row so the recording
 * shows up in the media library like any imported file.
 *
 * We deliberately reuse the regular media-asset pipeline (probe → row → background
 * proxy where applicable) so a recording is no different from a drag-and-dropped audio
 * file once saved — including waveform display, editing, and export support.
 */

import { app, ipcMain, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuid } from 'uuid';
import log from 'electron-log';
import { CH } from '../../shared/types';
import type {
  MediaAsset,
  VoicePromoteOpts,
  VoiceSaveRecordingOpts,
  VoiceWriteTempOpts,
  VoiceWriteTempResult,
} from '../../shared/types';
import { getDb } from '../services/db.service';
import { probeMedia } from '../services/ffmpeg.service';

function send(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function recordingsDir(): string {
  const dir = path.join(app.getPath('userData'), 'recordings');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pendingDir(): string {
  const dir = path.join(recordingsDir(), 'pending');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function buildFileName(baseName: string | undefined, ext: string): string {
  const safe = ((baseName && baseName.trim()) || 'voice')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 40);
  return `${safe}_${timestampSlug()}.${ext}`;
}

function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function registerVoiceRecordingHandlers(getWindow: () => BrowserWindow | null): void {
  // ---- Two-step flow (preferred) -----------------------------------------------------
  // 1. writeTemp(buffer) → temp file in recordings/pending/. Safety copy on Stop.
  // 2. promoteRecording(temp_path) → move into recordings/, insert MediaAsset row.
  // 3. discardTemp(temp_path) → cleanup if the user discarded before saving.

  ipcMain.handle(
    CH.voiceWriteTemp,
    async (_e, opts: VoiceWriteTempOpts): Promise<VoiceWriteTempResult> => {
      const ext = opts.extension || 'webm';
      const fileName = buildFileName(opts.base_name, ext);
      const tempPath = path.join(pendingDir(), fileName);
      const buffer = Buffer.from(opts.buffer);
      await fs.promises.writeFile(tempPath, buffer);
      log.info(`[voice] wrote pending temp ${tempPath} (${buffer.byteLength} bytes)`);
      return { temp_path: tempPath, file_size: buffer.byteLength };
    },
  );

  ipcMain.handle(
    CH.voicePromoteRecording,
    async (_e, opts: VoicePromoteOpts): Promise<MediaAsset> => {
      if (!fs.existsSync(opts.temp_path)) {
        throw new Error(`Pending recording not found: ${opts.temp_path}`);
      }
      // Guard against path-traversal: only promote files that came from our pending dir.
      const resolved = path.resolve(opts.temp_path);
      const pending = path.resolve(pendingDir());
      if (!resolved.startsWith(pending + path.sep) && resolved !== pending) {
        throw new Error('Refusing to promote a path outside the pending directory');
      }
      const fileName = path.basename(opts.temp_path);
      const destPath = path.join(recordingsDir(), fileName);
      await fs.promises.rename(opts.temp_path, destPath);

      const info = await probeMedia(destPath).catch((err) => {
        log.warn('[voice] probe failed on promote, falling back to bare asset', err);
        return null;
      });
      const probedDuration = info?.duration_ms ?? 0;
      const duration_ms =
        probedDuration > 0
          ? probedDuration
          : Math.max(0, Math.round(opts.duration_ms ?? 0));

      const asset: MediaAsset = {
        id: uuid(),
        project_id: opts.project_id,
        original_path: destPath,
        proxy_path: null,
        thumbnail_path: null,
        waveform_path: null,
        type: 'audio',
        duration_ms,
        width: null,
        height: null,
        fps: null,
        file_size: info?.file_size ?? fs.statSync(destPath).size,
        codec: info?.codec ?? null,
        created_at: Date.now(),
      };

      const db = getDb();
      db.prepare(
        `INSERT INTO media_assets (id, project_id, original_path, proxy_path, thumbnail_path, waveform_path,
         type, duration_ms, width, height, fps, file_size, codec, created_at)
         VALUES (@id, @project_id, @original_path, @proxy_path, @thumbnail_path, @waveform_path,
         @type, @duration_ms, @width, @height, @fps, @file_size, @codec, @created_at)`,
      ).run(asset);

      log.info(`[voice] promoted ${destPath} (${asset.duration_ms} ms)`);
      send(getWindow(), CH.mediaAssetUpdatedEvent, asset);
      return asset;
    },
  );

  ipcMain.handle(CH.voiceDiscardTemp, async (_e, tempPath: string): Promise<void> => {
    if (!tempPath) return;
    const resolved = path.resolve(tempPath);
    const pending = path.resolve(pendingDir());
    if (!resolved.startsWith(pending + path.sep)) return;
    try {
      if (fs.existsSync(resolved)) await fs.promises.unlink(resolved);
      log.info(`[voice] discarded pending ${resolved}`);
    } catch (err) {
      log.warn('[voice] discardTemp failed', err);
    }
  });

  // ---- Legacy one-shot flow (kept for back-compat; renderer no longer calls it) -----
  ipcMain.handle(
    CH.voiceSaveRecording,
    async (_e, opts: VoiceSaveRecordingOpts): Promise<MediaAsset> => {
      const ext = opts.extension || 'webm';
      const base = (opts.base_name && opts.base_name.trim()) || 'voice';
      const safeBase = base.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
      const fileName = `${safeBase}_${timestampSlug()}.${ext}`;
      const outPath = path.join(recordingsDir(), fileName);

      const buffer = Buffer.from(opts.buffer);
      await fs.promises.writeFile(outPath, buffer);

      const info = await probeMedia(outPath).catch((err) => {
        log.warn('[voice] probe failed, falling back to bare asset', err);
        return null;
      });

      // MediaRecorder webm doesn't carry a finalized duration header, so probe usually
      // returns 0 here. Fall back to the renderer-measured duration so the asset shows
      // up on the timeline at its real length.
      const probedDuration = info?.duration_ms ?? 0;
      const duration_ms =
        probedDuration > 0
          ? probedDuration
          : Math.max(0, Math.round(opts.duration_ms ?? 0));

      const asset: MediaAsset = {
        id: uuid(),
        project_id: opts.project_id,
        original_path: outPath,
        proxy_path: null,
        thumbnail_path: null,
        waveform_path: null,
        type: 'audio',
        duration_ms,
        width: null,
        height: null,
        fps: null,
        file_size: info?.file_size ?? buffer.byteLength,
        codec: info?.codec ?? null,
        created_at: Date.now(),
      };

      const db = getDb();
      db.prepare(
        `INSERT INTO media_assets (id, project_id, original_path, proxy_path, thumbnail_path, waveform_path,
         type, duration_ms, width, height, fps, file_size, codec, created_at)
         VALUES (@id, @project_id, @original_path, @proxy_path, @thumbnail_path, @waveform_path,
         @type, @duration_ms, @width, @height, @fps, @file_size, @codec, @created_at)`,
      ).run(asset);

      log.info(`[voice] saved ${outPath} (${asset.duration_ms} ms, ${asset.file_size} bytes)`);
      // Surface the new asset on the same channel `media:assetUpdated` so the library
      // refresh path picks it up without us re-querying.
      send(getWindow(), CH.mediaAssetUpdatedEvent, asset);
      return asset;
    },
  );
}
