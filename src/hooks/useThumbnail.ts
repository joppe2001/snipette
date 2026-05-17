import { useEffect, useState } from 'react';
import { fileUrl } from '@/utils/file';

// Persistent module-level cache: avoids re-fetching thumbnails when components remount.
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

function cacheKey(assetId: string, timeMs: number): string {
  return `${assetId}@${Math.round(timeMs)}`;
}

/**
 * Fetch a thumbnail for the given asset at the given time. Returns a `snipette-file://` URL the
 * renderer can use as an <img src>. The underlying jpeg lives in app userData/thumbnails.
 */
export function useThumbnail(assetId: string | null, timeMs = 0): string | null {
  const [src, setSrc] = useState<string | null>(() => {
    if (!assetId) return null;
    const k = cacheKey(assetId, timeMs);
    return cache.get(k) ?? null;
  });

  useEffect(() => {
    if (!assetId) return;
    const k = cacheKey(assetId, timeMs);
    const cached = cache.get(k);
    if (cached) {
      setSrc(cached);
      return;
    }
    let active = true;
    const existing = inFlight.get(k);
    const p =
      existing ??
      window.snipette.media
        .thumbnail(assetId, timeMs)
        .then((p) => {
          const url = fileUrl(p);
          cache.set(k, url);
          return url;
        })
        .catch(() => {
          // Silently fail — caller treats null as "use placeholder".
          return '';
        })
        .finally(() => inFlight.delete(k));
    inFlight.set(k, p);
    void p.then((url) => {
      if (active && url) setSrc(url);
    });
    return () => {
      active = false;
    };
  }, [assetId, timeMs]);

  return src;
}
