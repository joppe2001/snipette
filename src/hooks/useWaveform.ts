import { useEffect, useState } from 'react';

const cache = new Map<string, number[]>();

// Waveforms are big — each one is a Float64-sized array of peak samples. Cap the cache
// so opening many large audio assets in one session doesn't pin hundreds of MB of peaks
// in memory. 30 covers a generous working set without spilling.
const CACHE_CAP = 30;

/** LRU set: refresh insertion order on existing key; evict oldest when over the cap. */
function lruSet(key: string, value: number[]): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Refresh recency on read so frequently-shown waveforms outlive the eviction window. */
function lruGet(key: string): number[] | undefined {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

/** Drop all cached waveform peaks. Call on project switch to free memory. */
export function clearWaveformCache(): void {
  cache.clear();
}

export function useWaveform(assetId: string | null): number[] | null {
  const [data, setData] = useState<number[] | null>(assetId ? lruGet(assetId) ?? null : null);

  useEffect(() => {
    if (!assetId) {
      setData(null);
      return;
    }
    const hit = lruGet(assetId);
    if (hit !== undefined) {
      setData(hit);
      return;
    }
    let active = true;
    window.snipette.media
      .waveform(assetId)
      .then((d) => {
        lruSet(assetId, d);
        if (active) setData(d);
      })
      .catch(() => active && setData(null));
    return () => {
      active = false;
    };
  }, [assetId]);

  return data;
}
