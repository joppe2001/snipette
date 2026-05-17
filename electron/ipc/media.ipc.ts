import { app, ipcMain, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuid } from 'uuid';
import log from 'electron-log';
import { CH } from '../../shared/types';
import type { MediaAsset, MediaInfo, MediaType } from '../../shared/types';
import { getDb } from '../services/db.service';
import { probeMedia, generateProxy, extractWaveform } from '../services/ffmpeg.service';
import { getThumbnail } from '../services/thumbnail.service';
import { detectBeats } from '../services/beat-detect.service';

const inFlightProxies = new Set<string>();

function emitAssetUpdated(window: BrowserWindow | null, asset: MediaAsset): void {
  if (window && !window.isDestroyed()) window.webContents.send(CH.mediaAssetUpdatedEvent, asset);
}

function emitProxyProgress(window: BrowserWindow | null, assetId: string, percent: number): void {
  if (window && !window.isDestroyed())
    window.webContents.send(CH.mediaProxyProgressEvent, { assetId, percent });
}

async function ensureProxyInBackground(asset: MediaAsset, getWindow: () => BrowserWindow | null): Promise<void> {
  if (asset.type !== 'video' && asset.type !== 'image') return;
  if (asset.type === 'image') return; // images don't need proxies
  if (inFlightProxies.has(asset.id)) return;
  if (asset.proxy_path && fs.existsSync(asset.proxy_path)) return;
  inFlightProxies.add(asset.id);
  try {
    const dir = path.join(app.getPath('userData'), 'proxies');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${asset.id}.mp4`);
    log.info(`[media] generating proxy for ${asset.id}`);
    await generateProxy(asset.original_path, out, asset.duration_ms ?? 0, (pct) => {
      emitProxyProgress(getWindow(), asset.id, pct);
    });
    const db = getDb();
    db.prepare('UPDATE media_assets SET proxy_path = ? WHERE id = ?').run(out, asset.id);
    const updated = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(asset.id) as MediaAsset;
    emitAssetUpdated(getWindow(), updated);
    log.info(`[media] proxy ready for ${asset.id}`);
  } catch (e) {
    log.error(`[media] proxy failed for ${asset.id}`, e);
  } finally {
    inFlightProxies.delete(asset.id);
  }
}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv', '.ts']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.heic']);

function classify(p: string): MediaType {
  const ext = path.extname(p).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'video';
}

export function registerMediaHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CH.mediaImport, async (_e, projectId: string, paths: string[]): Promise<MediaAsset[]> => {
    const db = getDb();
    const out: MediaAsset[] = [];
    for (const p of paths) {
      try {
        if (!fs.existsSync(p)) {
          log.warn(`[media] skip missing ${p}`);
          continue;
        }
        const info = await probeMedia(p);
        const id = uuid();
        const asset: MediaAsset = {
          id,
          project_id: projectId,
          original_path: p,
          proxy_path: null,
          thumbnail_path: null,
          waveform_path: null,
          type: classify(p),
          duration_ms: info.duration_ms,
          width: info.width,
          height: info.height,
          fps: info.fps,
          file_size: info.file_size,
          codec: info.codec,
          created_at: Date.now(),
        };
        db.prepare(
          `INSERT INTO media_assets (id, project_id, original_path, proxy_path, thumbnail_path, waveform_path,
           type, duration_ms, width, height, fps, file_size, codec, created_at)
           VALUES (@id, @project_id, @original_path, @proxy_path, @thumbnail_path, @waveform_path,
           @type, @duration_ms, @width, @height, @fps, @file_size, @codec, @created_at)`,
        ).run(asset);
        out.push(asset);
      } catch (e) {
        log.error(`[media] import failed for ${p}`, e);
      }
    }
    // Kick off proxy generation in the background for every video asset. Chromium's <video>
    // element can't decode HEVC / ProRes / some MOV variants; the H.264 proxy is universally playable.
    for (const a of out) {
      void ensureProxyInBackground(a, getWindow);
    }
    return out;
  });

  ipcMain.handle(CH.mediaList, (_e, projectId: string): MediaAsset[] => {
    const rows = getDb()
      .prepare('SELECT * FROM media_assets WHERE project_id = ? ORDER BY created_at')
      .all(projectId) as MediaAsset[];
    // Backfill any missing proxies for previously-imported video assets.
    for (const r of rows) {
      if (r.type === 'video' && (!r.proxy_path || !fs.existsSync(r.proxy_path))) {
        void ensureProxyInBackground(r, getWindow);
      }
    }
    return rows;
  });

  ipcMain.handle(CH.mediaGenerateProxy, async (_e, assetId: string): Promise<string> => {
    const db = getDb();
    const asset = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(assetId) as MediaAsset | undefined;
    if (!asset) throw new Error(`Asset ${assetId} not found`);
    if (asset.proxy_path && fs.existsSync(asset.proxy_path)) return asset.proxy_path;
    const dir = path.join(app.getPath('userData'), 'proxies');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${assetId}.mp4`);
    await generateProxy(asset.original_path, out, asset.duration_ms ?? 0);
    db.prepare('UPDATE media_assets SET proxy_path = ? WHERE id = ?').run(out, assetId);
    return out;
  });

  ipcMain.handle(CH.mediaThumbnail, async (_e, assetId: string, timeMs: number): Promise<string> => {
    const db = getDb();
    const asset = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(assetId) as MediaAsset | undefined;
    if (!asset) throw new Error(`Asset ${assetId} not found`);
    const cacheDir = path.join(app.getPath('userData'), 'thumbnails');
    return getThumbnail(assetId, asset.original_path, cacheDir, timeMs);
  });

  ipcMain.handle(CH.mediaWaveform, async (_e, assetId: string): Promise<number[]> => {
    const db = getDb();
    const asset = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(assetId) as MediaAsset | undefined;
    if (!asset) throw new Error(`Asset ${assetId} not found`);
    const dir = path.join(app.getPath('userData'), 'waveforms');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const cached = path.join(dir, `${assetId}.json`);
    if (fs.existsSync(cached)) {
      try {
        return JSON.parse(fs.readFileSync(cached, 'utf-8')) as number[];
      } catch {
        // re-extract on parse error
      }
    }
    const data = await extractWaveform(asset.original_path, 600);
    fs.writeFileSync(cached, JSON.stringify(data));
    db.prepare('UPDATE media_assets SET waveform_path = ? WHERE id = ?').run(cached, assetId);
    return data;
  });

  ipcMain.handle(
    CH.mediaDetectBeats,
    async (
      _e,
      assetId: string,
      opts?: { threshold?: number; minIntervalMs?: number },
    ): Promise<number[]> => {
      const db = getDb();
      const asset = db
        .prepare('SELECT * FROM media_assets WHERE id = ?')
        .get(assetId) as MediaAsset | undefined;
      if (!asset) throw new Error(`Asset ${assetId} not found`);
      return detectBeats(asset.original_path, opts);
    },
  );

  ipcMain.handle(CH.mediaProbe, async (_e, p: string): Promise<MediaInfo> => probeMedia(p));

  ipcMain.handle(CH.mediaDelete, async (_e, assetId: string): Promise<void> => {
    const db = getDb();
    const asset = db
      .prepare('SELECT * FROM media_assets WHERE id = ?')
      .get(assetId) as MediaAsset | undefined;
    if (!asset) return;
    // Delete derived files. The ORIGINAL source on disk is left untouched on purpose —
    // the user owns it, Snipette only owns its caches and the DB row.
    for (const p of [asset.proxy_path, asset.thumbnail_path, asset.waveform_path]) {
      if (p) {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (e) {
          log.warn('[media] failed to remove derived file', p, e);
        }
      }
    }
    // Clips referencing this asset would dangle — null out their asset_id so the timeline
    // is consistent. (Could also delete the clips; preserving them lets the user re-link.)
    db.prepare('UPDATE clips SET asset_id = NULL WHERE asset_id = ?').run(assetId);
    db.prepare('DELETE FROM media_assets WHERE id = ?').run(assetId);
    log.info(`[media] deleted asset ${assetId}`);
  });

  ipcMain.handle(CH.mediaRegenerateProxy, async (_e, assetId: string): Promise<void> => {
    const db = getDb();
    const asset = db
      .prepare('SELECT * FROM media_assets WHERE id = ?')
      .get(assetId) as MediaAsset | undefined;
    if (!asset) return;
    // Force regeneration: clear the existing proxy reference + file, then re-run.
    if (asset.proxy_path && fs.existsSync(asset.proxy_path)) {
      try {
        fs.unlinkSync(asset.proxy_path);
      } catch (e) {
        log.warn('[media] failed to remove proxy', asset.proxy_path, e);
      }
    }
    db.prepare('UPDATE media_assets SET proxy_path = NULL WHERE id = ?').run(assetId);
    const refreshed = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(assetId) as
      | MediaAsset
      | undefined;
    if (refreshed) {
      emitAssetUpdated(getWindow(), refreshed);
      void ensureProxyInBackground(refreshed, getWindow);
    }
  });
}
