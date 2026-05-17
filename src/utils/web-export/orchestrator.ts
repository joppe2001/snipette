/**
 * Main loop for the WebCodecs/canvas export. Owns:
 *   - the OffscreenCanvas the compositor paints onto
 *   - the FrameSource that yields decoded VideoFrames
 *   - the encoder + muxer
 *   - the per-frame progress reporting
 *
 * Hands off to main process at the end for audio render + final MP4 mux.
 */

import { createCanvasEncoder } from './encoder';
import { createFrameSource } from './frame-source';
import { renderFrame } from './compositor';
import type { WebExportOpts, WebExportProgress, WebExportResult } from './types';

/** Tunable: report progress at most this often (ms). Frame-by-frame would flood Zustand. */
const PROGRESS_DEBOUNCE_MS = 100;

export interface RunOpts {
  onProgress: (p: WebExportProgress) => void;
  signal?: AbortSignal;
}

export async function runOrchestrator(
  opts: WebExportOpts,
  { onProgress, signal }: RunOpts,
): Promise<WebExportResult> {
  const { width, height, fps, project } = opts;
  const durationMs = Math.max(
    1,
    project.duration_ms ||
      opts.clips.reduce((m, c) => Math.max(m, c.start_time_ms + c.duration_ms), 0),
  );
  const totalFrames = Math.max(1, Math.ceil((durationMs / 1000) * fps));

  if (signal?.aborted) throw new Error('Export cancelled');

  // --- Canvas setup ---
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is unavailable in this environment');
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Failed to acquire 2D context on OffscreenCanvas');

  // --- Frame source + encoder ---
  const frameSource = createFrameSource(opts.assets);
  const encoder = await createCanvasEncoder({
    width,
    height,
    fps,
    format: opts.format,
    quality: opts.quality,
    targetBitrate: opts.targetBitrate,
  });

  // The editor stores font_size, position offsets, motion-FX translates, etc. as CSS
  // pixels in the *preview* canvas's coordinate space. When the preview is e.g. 400px
  // wide and we export at 1080, font_size: 56 visually shrinks to a third. Scaling
  // every preview-pixel value by `width / previewWidth` restores parity.
  const previewScale =
    opts.previewWidth && opts.previewWidth > 0 ? width / opts.previewWidth : 1;

  const abortAll = () => {
    try {
      encoder.abort();
    } catch {
      // ignore
    }
    try {
      frameSource.dispose();
    } catch {
      // ignore
    }
  };
  const abortListener = () => abortAll();
  signal?.addEventListener('abort', abortListener);

  let lastProgressAt = 0;
  const startedAt = performance.now();

  try {
    onProgress({ fraction: 0, stage: 'Preparing canvas', etaSeconds: 0 });

    // OffscreenCanvas2D inherits the document's font set, but only once those font
    // faces have actually loaded. Without this await, the first frames render with a
    // system fallback font (Sora/Barlow/etc. quietly missing). Race with a 2s timeout
    // so a stuck `<link rel="stylesheet">` doesn't deadlock the export.
    if (typeof document !== 'undefined' && document.fonts && typeof document.fonts.ready?.then === 'function') {
      try {
        await Promise.race([
          document.fonts.ready,
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
      } catch {
        // Non-fatal — proceed with whatever fonts are currently available.
      }
    }

    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new Error('Export cancelled');
      const playheadMs = (i / fps) * 1000;
      await renderFrame(
        {
          ctx,
          width,
          height,
          tracks: opts.tracks,
          clips: opts.clips,
          transitions: opts.transitions,
          assets: opts.assets,
          frameSource,
          previewScale,
        },
        playheadMs,
      );

      // Wrap canvas as a VideoFrame at the precise timestamp the encoder expects.
      const timestampMicros = Math.round(playheadMs * 1000);
      const vf = new VideoFrame(canvas, {
        timestamp: timestampMicros,
        duration: Math.round(1_000_000 / fps),
      });
      await encoder.encode(vf, timestampMicros, i === 0);

      const now = performance.now();
      if (now - lastProgressAt > PROGRESS_DEBOUNCE_MS || i === totalFrames - 1) {
        lastProgressAt = now;
        const elapsed = (now - startedAt) / 1000;
        const frac = (i + 1) / totalFrames;
        const remaining = elapsed > 0.1 && frac > 0 ? (elapsed / frac) * (1 - frac) : 0;
        onProgress({
          fraction: 0.85 * frac,
          stage: 'Encoding video',
          etaSeconds: Math.max(0, remaining),
        });
      }
    }

    onProgress({ fraction: 0.85, stage: 'Finalizing video', etaSeconds: 0 });
    const videoBuffer = await encoder.finalize();
    if (signal?.aborted) throw new Error('Export cancelled');

    // --- Audio render (parallel-friendly, but order matters for final mux) ---
    let audioPath: string | null = null;
    if (opts.includeAudio) {
      onProgress({ fraction: 0.9, stage: 'Rendering audio', etaSeconds: 0 });
      audioPath = await window.snipette.webExport.renderAudio({
        project_id: project.id,
        normalize_loudness: opts.normalizeLoudness,
      });
    }
    if (signal?.aborted) throw new Error('Export cancelled');

    onProgress({ fraction: 0.96, stage: 'Muxing final file', etaSeconds: 0 });
    const result = await window.snipette.webExport.muxFinal({
      output_path: opts.outputPath,
      video_buffer: videoBuffer,
      audio_path: audioPath,
    });

    onProgress({ fraction: 1, stage: 'Complete', etaSeconds: 0 });
    return { outputPath: result.output_path, fileSizeBytes: result.file_size_bytes };
  } finally {
    signal?.removeEventListener('abort', abortListener);
    try {
      frameSource.dispose();
    } catch {
      // ignore
    }
  }
}
