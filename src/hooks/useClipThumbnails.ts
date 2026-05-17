import { useEffect, useState } from 'react';
import { fileUrl } from '@/utils/file';

// Persistent module-level cache: keyed by `${assetId}::${roundedTimeMs}`. Survives component
// remounts so scrolling the timeline doesn't re-fetch thumbnails we've already decoded.
const urlCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

// Cap the thumbnail URL cache so a long editing session over many projects doesn't grow
// memory unboundedly. ~2000 entries is roughly ~80 video clips at 25 thumbnails each — well
// past what's visible on the timeline at any zoom level.
const URL_CACHE_CAP = 2000;

function cacheKey(assetId: string, timeMs: number): string {
  return `${assetId}::${Math.round(timeMs)}`;
}

/**
 * LRU-style set: refresh insertion order on existing keys and evict the oldest entries
 * once the cap is exceeded. Map iteration is insertion-order, so `keys().next().value`
 * is reliably the least-recently-written key.
 */
function lruSetUrl(key: string, value: string): void {
  if (urlCache.has(key)) urlCache.delete(key);
  urlCache.set(key, value);
  while (urlCache.size > URL_CACHE_CAP) {
    const oldest = urlCache.keys().next();
    if (oldest.done) break;
    urlCache.delete(oldest.value);
  }
}

/**
 * Clears the entire thumbnail URL cache. Useful on project switch — orphaned URLs from
 * the previous project's assets keep snipette-file:// references alive and the in-process
 * thumb file handles open. Exported so callers (project-switch effects) can invalidate.
 */
export function clearThumbnailCache(): void {
  urlCache.clear();
}

function fetchThumbnailUrl(assetId: string, timeMs: number): Promise<string> {
  const key = cacheKey(assetId, timeMs);
  const cached = urlCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = window.snipette.media
    .thumbnail(assetId, timeMs)
    .then((absPath) => {
      const url = fileUrl(absPath);
      lruSetUrl(key, url);
      return url;
    })
    .catch(() => {
      // Treat failure as a permanent miss for this (assetId,time) so we don't hammer IPC.
      lruSetUrl(key, '');
      return '';
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

interface UseClipThumbnailsResult {
  urls: (string | null)[];
}

/**
 * Fetches `count` evenly-spaced thumbnails for an asset between source-in and source-out.
 *
 * Sample times are along the SOURCE range (not the timeline range), so trimmed clips show
 * the right frames. Returns an array of length `count`; entries are `null` while loading
 * and become snipette-file:// URLs as each one resolves. Each thumbnail is fetched in
 * parallel via Promise.allSettled and resolved entries update state independently of the
 * others — slow thumbnails don't block fast ones.
 */
export function useClipThumbnails(
  assetId: string | null | undefined,
  sourceInMs: number,
  sourceOutMs: number,
  count: number,
): UseClipThumbnailsResult {
  const safeCount = Math.max(1, Math.floor(count));

  const computeInitial = (): (string | null)[] => {
    if (!assetId) return Array<string | null>(safeCount).fill(null);
    const out: (string | null)[] = [];
    for (let i = 0; i < safeCount; i++) {
      const t = sampleTimeFor(i, safeCount, sourceInMs, sourceOutMs);
      const hit = urlCache.get(cacheKey(assetId, t));
      out.push(hit && hit.length > 0 ? hit : null);
    }
    return out;
  };

  const [urls, setUrls] = useState<(string | null)[]>(computeInitial);

  useEffect(() => {
    if (!assetId) {
      setUrls(Array<string | null>(safeCount).fill(null));
      return;
    }

    let active = true;

    // Seed from cache synchronously so we don't flash placeholders for already-loaded thumbs.
    // This part is cheap — just a Map lookup — and runs on every change so the displayed
    // urls always reflect the *latest* trim position when a cached thumb exists.
    const seeded: (string | null)[] = [];
    const pending: { index: number; time: number }[] = [];
    for (let i = 0; i < safeCount; i++) {
      const t = sampleTimeFor(i, safeCount, sourceInMs, sourceOutMs);
      const hit = urlCache.get(cacheKey(assetId, t));
      if (hit !== undefined) {
        seeded.push(hit.length > 0 ? hit : null);
      } else {
        seeded.push(null);
        pending.push({ index: i, time: t });
      }
    }
    setUrls(seeded);

    if (pending.length === 0) {
      return () => {
        active = false;
      };
    }

    // Critical performance fix: during a trim/slip drag the source_in/out fields change
    // every pointermove (60Hz). Without this debounce we'd spawn FFmpeg ~60×N times per
    // second to extract frames the user will never see (they're already scrolling past).
    // Wait 180 ms of stability before firing the actual IPC fetches. The seeded cache
    // step above still updates the UI instantly when thumbnails are already in memory,
    // so this debounce is invisible after the first pass over any given region.
    const handle = setTimeout(() => {
      if (!active) return;
      void Promise.allSettled(
        pending.map(({ index, time }) =>
          fetchThumbnailUrl(assetId, time).then((url) => {
            if (!active) return;
            if (!url) return;
            setUrls((prev) => {
              if (prev[index] === url) return prev;
              const next = prev.slice();
              next[index] = url;
              return next;
            });
          }),
        ),
      );
    }, 180);

    return () => {
      active = false;
      clearTimeout(handle);
    };
  }, [assetId, sourceInMs, sourceOutMs, safeCount]);

  return { urls };
}

/**
 * For a given thumbnail index, returns the source-time we should sample.
 * Samples are centered within each "slot" so the first thumbnail isn't pinned exactly
 * to source_in_ms (which often shows a leading black frame on poorly-keyed videos).
 */
function sampleTimeFor(index: number, count: number, sourceInMs: number, sourceOutMs: number): number {
  const span = Math.max(0, sourceOutMs - sourceInMs);
  if (count <= 1 || span === 0) return quantize(sourceInMs + span / 2);
  const slot = span / count;
  return quantize(sourceInMs + slot * (index + 0.5));
}

/** Round to the nearest 250 ms so tiny trim jitter doesn't blow the per-frame cache. */
function quantize(timeMs: number): number {
  return Math.round(timeMs / 250) * 250;
}
