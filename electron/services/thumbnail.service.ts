import fs from 'node:fs';
import path from 'node:path';
import { extractThumbnail } from './ffmpeg.service';

interface CacheEntry {
  path: string;
  ts: number;
}

const MEM_CACHE = new Map<string, CacheEntry>();
const MAX_MEM = 256;

function key(assetId: string, timeMs: number): string {
  return `${assetId}:${Math.round(timeMs / 100) * 100}`;
}

export async function getThumbnail(
  assetId: string,
  sourcePath: string,
  cacheDir: string,
  timeMs: number,
  width = 320,
): Promise<string> {
  const k = key(assetId, timeMs);
  const existing = MEM_CACHE.get(k);
  if (existing && fs.existsSync(existing.path)) {
    existing.ts = Date.now();
    return existing.path;
  }
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${k.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`);
  if (!fs.existsSync(out)) {
    await extractThumbnail(sourcePath, out, timeMs, width);
  }
  MEM_CACHE.set(k, { path: out, ts: Date.now() });
  if (MEM_CACHE.size > MAX_MEM) {
    // LRU evict oldest
    const sorted = [...MEM_CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < sorted.length - MAX_MEM; i++) MEM_CACHE.delete(sorted[i][0]);
  }
  return out;
}

export function clearMemCache(): void {
  MEM_CACHE.clear();
}
