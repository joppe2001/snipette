/**
 * Frame source: maintains a pool of hidden `<video>` elements + decoded `ImageBitmap`s
 * keyed by media asset, and exposes `frameAt(clip, playheadMs)` which seeks the right
 * element and returns a `CanvasImageSource` plus its intrinsic dimensions.
 *
 * Critically, this module does NOT construct a `VideoFrame` from the video element.
 * Doing so requires the element's decoder to be in `HAVE_CURRENT_DATA` AND for the
 * decoded frame to be committed to a presentable surface — which is racy in Chromium
 * even after the `seeked` event. Instead, callers `ctx.drawImage(source, ...)` onto an
 * OffscreenCanvas and wrap THAT as a `VideoFrame` at the encoder boundary.
 *
 * Why `<video>` instead of `VideoDecoder` directly:
 *   - `<video>` works out of the box with `snipette-file://` (range requests + Chromium
 *     demuxing). `VideoDecoder` requires us to demux the container ourselves (mp4box.js).
 *   - `<video>.currentTime` accuracy varies by container; for our use case (proxies are
 *     H.264 with frequent keyframes) it's accurate enough.
 *   - Image and audio assets are handled separately: images use `ImageBitmap` (drawable
 *     without a decoder), audio assets contribute nothing to the visual.
 */

import { fileUrl } from '@/utils/file';
import type { Clip, MediaAsset } from '@shared/types';

interface VideoEntry {
  el: HTMLVideoElement;
  /** Resolves once `readyState >= HAVE_CURRENT_DATA` — i.e. the first frame is decoded. */
  readyPromise: Promise<void>;
  ready: boolean;
  width: number;
  height: number;
}

interface ImageEntry {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/** What `frameAt` returns. Sourced from `<video>` or `ImageBitmap`. */
export interface ClipFrame {
  source: CanvasImageSource;
  width: number;
  height: number;
}

export interface FrameSource {
  /**
   * Get a {@link ClipFrame} for the given clip at the given timeline-relative playhead.
   * Returns null for asset types that don't render (e.g. audio-only).
   */
  frameAt(clip: Clip, playheadMs: number): Promise<ClipFrame | null>;
  /** Release all underlying media elements + bitmaps. */
  dispose(): void;
}

export function createFrameSource(assets: MediaAsset[]): FrameSource {
  const videos = new Map<string, VideoEntry>();
  const images = new Map<string, ImageEntry>();
  const containerEl =
    typeof document !== 'undefined'
      ? (() => {
          // 1×1 px so Chromium doesn't aggressively cull rendering (zero-size or
          // display:none can defer decoding in some configurations).
          const div = document.createElement('div');
          div.style.position = 'fixed';
          div.style.top = '0';
          div.style.left = '0';
          div.style.width = '1px';
          div.style.height = '1px';
          div.style.opacity = '0';
          div.style.pointerEvents = 'none';
          div.style.overflow = 'hidden';
          document.body.appendChild(div);
          return div;
        })()
      : null;

  function getAsset(assetId: string | null): MediaAsset | null {
    if (!assetId) return null;
    return assets.find((a) => a.id === assetId) ?? null;
  }

  function getOrCreateVideo(asset: MediaAsset): VideoEntry {
    const cached = videos.get(asset.id);
    if (cached) return cached;
    if (!containerEl) {
      throw new Error('FrameSource requires a DOM (cannot run in worker without it)');
    }

    // Always prefer the original. The proxy is a 540p re-encode generated for fluid
    // editor scrubbing — using it at export time silently caps output at proxy resolution
    // regardless of the chosen quality. We only fall back to the proxy if the original
    // is missing (e.g. file moved/deleted post-import).
    const path = asset.original_path || asset.proxy_path || '';
    if (!path) {
      throw new Error(`Asset ${asset.id} has no readable source path`);
    }
    const el = document.createElement('video');
    el.crossOrigin = 'anonymous';
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    // Some Chromium builds defer the first frame decode until the element is in the DOM.
    containerEl.appendChild(el);
    el.src = fileUrl(path);

    const entry: VideoEntry = {
      el,
      ready: false,
      width: 0,
      height: 0,
      readyPromise: new Promise<void>((resolve, reject) => {
        // 'loadeddata' fires at readyState >= HAVE_CURRENT_DATA. 'loadedmetadata' is too
        // early — dimensions are known but no frame data is decoded, and a follow-up
        // seek + VideoFrame construction will throw 'Invalid source state'.
        const onReady = () => {
          entry.ready = true;
          entry.width = el.videoWidth || 0;
          entry.height = el.videoHeight || 0;
          cleanup();
          resolve();
        };
        const onErr = () => {
          cleanup();
          reject(new Error(`Failed to load video for asset ${asset.id}: ${path}`));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `Video load timed out (>10s) for asset ${asset.id}. Path: ${path}. readyState=${el.readyState}, networkState=${el.networkState}`,
            ),
          );
        }, 10_000);
        function cleanup() {
          clearTimeout(timer);
          el.removeEventListener('loadeddata', onReady);
          el.removeEventListener('error', onErr);
        }
        el.addEventListener('loadeddata', onReady);
        el.addEventListener('error', onErr);
        // If by chance the element is already past readyState 2 (cached/same src), fire
        // immediately so we don't deadlock on a missed event.
        if (el.readyState >= 2) onReady();
      }),
    };
    videos.set(asset.id, entry);
    return entry;
  }

  async function getOrCreateImage(asset: MediaAsset): Promise<ImageEntry> {
    const cached = images.get(asset.id);
    if (cached) return cached;
    // Always prefer the original. (Same rationale as videos; for images the proxy is
    // usually identical to the original anyway, but stay consistent.)
    const path = asset.original_path || asset.proxy_path || '';
    if (!path) {
      throw new Error(`Asset ${asset.id} has no readable source path`);
    }
    const response = await fetch(fileUrl(path));
    if (!response.ok) throw new Error(`Failed to fetch image ${path}: ${response.status}`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const entry: ImageEntry = { bitmap, width: bitmap.width, height: bitmap.height };
    images.set(asset.id, entry);
    return entry;
  }

  async function seekTo(entry: VideoEntry, sourceTimeS: number): Promise<void> {
    if (!entry.ready) await entry.readyPromise;
    const el = entry.el;
    const dur = Number.isFinite(el.duration) ? el.duration : sourceTimeS;
    const target = Math.max(0, Math.min(dur > 0 ? dur - 0.001 : sourceTimeS, sourceTimeS));
    const drift = Math.abs(el.currentTime - target);

    if (drift < 1 / 240) return; // sub-frame; already there.

    await new Promise<void>((resolve, reject) => {
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error(`Seek failed at t=${target.toFixed(3)}s`));
      };
      // Off-screen / opacity-0 video elements occasionally drop 'seeked' (presentation
      // is culled). Cap our wait so the orchestrator surfaces a clear error rather than
      // hanging forever. 4s is generous — typical seek on H.264 proxies is <50ms.
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Seek timed out (>4s) at t=${target.toFixed(3)}s, currentTime=${el.currentTime.toFixed(3)}, readyState=${el.readyState}`,
          ),
        );
      }, 4_000);
      function cleanup() {
        clearTimeout(timer);
        el.removeEventListener('seeked', onSeeked);
        el.removeEventListener('error', onErr);
      }
      el.addEventListener('seeked', onSeeked);
      el.addEventListener('error', onErr);
      try {
        el.currentTime = target;
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    // 'seeked' guarantees the decoded frame is available to `ctx.drawImage(video, …)`.
    // We previously waited for `requestVideoFrameCallback` here, but rVFC fires only
    // when the compositor presents the element — which never happens for our 1×1 opacity-0
    // capture element, so it would hang forever.
  }

  return {
    async frameAt(clip, playheadMs) {
      const asset = getAsset(clip.asset_id);
      if (!asset) return null;
      if (asset.type === 'audio') return null;

      if (asset.type === 'image') {
        const img = await getOrCreateImage(asset);
        return { source: img.bitmap, width: img.width, height: img.height };
      }

      // Video
      const entry = getOrCreateVideo(asset);
      const offset = playheadMs - clip.start_time_ms;
      const sourceTimeMs = clip.source_in_ms + offset * Math.max(0.05, clip.speed);
      await seekTo(entry, sourceTimeMs / 1000);

      // Belt-and-suspenders: if readyState somehow regressed below HAVE_CURRENT_DATA
      // (rare; can happen after `removeAttribute('src')` + `.load()`), wait briefly.
      if (entry.el.readyState < 2) {
        await new Promise((r) => setTimeout(r, 32));
      }

      return {
        source: entry.el,
        width: entry.width || entry.el.videoWidth || 0,
        height: entry.height || entry.el.videoHeight || 0,
      };
    },

    dispose() {
      for (const v of videos.values()) {
        try {
          v.el.pause();
          v.el.removeAttribute('src');
          v.el.load();
          v.el.remove();
        } catch {
          // ignore — element teardown is best-effort
        }
      }
      videos.clear();
      for (const i of images.values()) {
        try {
          i.bitmap.close();
        } catch {
          // ignore
        }
      }
      images.clear();
      if (containerEl) containerEl.remove();
    },
  };
}
