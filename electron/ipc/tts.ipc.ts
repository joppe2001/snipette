/**
 * IPC for the macOS-backed TTS. Generates a single voice line, runs it through ffprobe
 * for duration, and registers a MediaAsset so the renderer can spawn a clip on the
 * timeline pointing at the freshly-made audio file.
 */

import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import { v4 as uuid } from 'uuid';
import log from 'electron-log';
import { CH } from '../../shared/types';
import type {
  MediaAsset,
  TtsGenerateOpts,
  TtsVoice,
} from '../../shared/types';
import { getDb } from '../services/db.service';
import { probeMedia } from '../services/ffmpeg.service';
import { listVoices, speakToFile } from '../services/tts.service';

function send(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

export function registerTtsHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    CH.ttsGenerate,
    async (_e, opts: TtsGenerateOpts): Promise<MediaAsset> => {
      const filePath = await speakToFile({
        text: opts.text,
        voice: opts.voice,
        rate: opts.rate,
      });
      const info = await probeMedia(filePath).catch((err) => {
        log.warn('[tts] probe failed', err);
        return null;
      });
      const asset: MediaAsset = {
        id: uuid(),
        project_id: opts.project_id,
        original_path: filePath,
        proxy_path: null,
        thumbnail_path: null,
        waveform_path: null,
        type: 'audio',
        duration_ms: info?.duration_ms ?? 0,
        width: null,
        height: null,
        fps: null,
        file_size: info?.file_size ?? fs.statSync(filePath).size,
        codec: info?.codec ?? 'aac',
        created_at: Date.now(),
      };
      const db = getDb();
      db.prepare(
        `INSERT INTO media_assets (id, project_id, original_path, proxy_path, thumbnail_path, waveform_path,
         type, duration_ms, width, height, fps, file_size, codec, created_at)
         VALUES (@id, @project_id, @original_path, @proxy_path, @thumbnail_path, @waveform_path,
         @type, @duration_ms, @width, @height, @fps, @file_size, @codec, @created_at)`,
      ).run(asset);
      send(getWindow(), CH.mediaAssetUpdatedEvent, asset);
      return asset;
    },
  );

  ipcMain.handle(CH.ttsListVoices, async (): Promise<TtsVoice[]> => {
    return listVoices();
  });
}
