/**
 * Thin wrapper around the platform `VideoEncoder` + mp4-muxer's `Muxer`. Hides the
 * back-pressure dance and the slight differences between H.264 and H.265 config.
 *
 * Usage:
 *   const enc = await createCanvasEncoder({ width, height, fps, codec, bitrate });
 *   for (const frame of frames) {
 *     await enc.encode(frame, timestampMicros);
 *     frame.close();
 *   }
 *   const buffer = await enc.finalize();   // ArrayBuffer of an MP4 with the video track
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { videoCodecFor, QUALITY_BITRATE } from './types';
import type { ExportFormat, ExportQuality } from '@shared/types';

export interface CanvasEncoderOpts {
  width: number;
  height: number;
  fps: number;
  format: ExportFormat;
  quality: ExportQuality;
  /** Bits per second; overrides quality-derived bitrate when set. */
  targetBitrate?: number;
}

export interface CanvasEncoder {
  /** Encode a frame at the given timestamp (microseconds). Awaits if the queue is full. */
  encode(frame: VideoFrame, timestampMicros: number, keyFrame?: boolean): Promise<void>;
  /** Flush + finalize. Returns the encoded MP4 bytes. */
  finalize(): Promise<ArrayBuffer>;
  /** Hard-abort: drops any pending frames. */
  abort(): void;
}

/**
 * Build a {@link CanvasEncoder}. Throws if the requested codec isn't supported by the
 * runtime — callers should catch and fall back to the legacy export.
 */
export async function createCanvasEncoder(opts: CanvasEncoderOpts): Promise<CanvasEncoder> {
  const mapped = videoCodecFor(opts.format);
  if (!mapped) {
    throw new Error(
      `Format ${opts.format} is not supported by the WebCodecs export path. Use legacy export.`,
    );
  }

  const bitrate = Math.max(
    100_000,
    Math.floor(opts.targetBitrate ?? QUALITY_BITRATE[opts.quality]),
  );

  const config: VideoEncoderConfig = {
    codec: mapped.webCodec,
    width: opts.width,
    height: opts.height,
    bitrate,
    framerate: opts.fps,
    // Annex B is friendlier for muxing into MP4 via avcc/hvcc boxes mp4-muxer expects.
    // mp4-muxer accepts both; leave default (= 'avc'/'hevc' codec-private metadata).
  };

  if (typeof VideoEncoder === 'undefined' || typeof VideoEncoder.isConfigSupported !== 'function') {
    throw new Error('VideoEncoder API unavailable in this environment');
  }

  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported || !support.config) {
    throw new Error(`VideoEncoder rejected config for ${opts.format} (${mapped.webCodec})`);
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: mapped.muxerCodec,
      width: opts.width,
      height: opts.height,
      frameRate: opts.fps,
    },
    // 'in-memory' keeps metadata at the start of the file (better playback compatibility)
    // by holding chunks in RAM until finalize. Acceptable for typical creator-tool exports;
    // can switch to 'fragmented' or a StreamTarget for multi-hour renders.
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let aborted = false;
  let encodedFrames = 0;
  let encoderError: Error | null = null;

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (aborted) return;
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (err) {
        encoderError = err instanceof Error ? err : new Error(String(err));
      }
    },
    error: (err) => {
      encoderError = err instanceof Error ? err : new Error(String(err));
    },
  });

  encoder.configure(support.config);

  const KEYFRAME_INTERVAL = Math.max(1, Math.round(opts.fps * 2));

  async function waitForCapacity(): Promise<void> {
    // VideoEncoder back-pressure: when queue is too long, yield and let it drain. The
    // exact threshold is a tuning knob — 8 keeps memory bounded while saturating modern
    // hardware encoders.
    while (encoder.encodeQueueSize > 8 && !aborted) {
      if (encoderError) throw encoderError;
      await new Promise((r) => setTimeout(r, 4));
    }
    if (encoderError) throw encoderError;
  }

  return {
    async encode(frame, timestampMicros, keyFrame) {
      if (aborted) {
        frame.close();
        return;
      }
      if (encoderError) {
        frame.close();
        throw encoderError;
      }
      await waitForCapacity();
      const isKey = keyFrame ?? encodedFrames % KEYFRAME_INTERVAL === 0;
      // VideoFrame timestamp must match what we pass here. We always set the timestamp
      // explicitly via the second arg to ensure monotonic increase.
      try {
        encoder.encode(frame, { keyFrame: isKey });
      } finally {
        frame.close();
      }
      encodedFrames++;
      // Force first frame to be a keyframe regardless of mod-arithmetic.
      void timestampMicros;
    },

    async finalize() {
      if (aborted) throw new Error('Encoder was aborted');
      if (encoderError) throw encoderError;
      await encoder.flush();
      if (encoderError) throw encoderError;
      muxer.finalize();
      encoder.close();
      const target = muxer.target as ArrayBufferTarget;
      return target.buffer;
    },

    abort() {
      aborted = true;
      try {
        encoder.close();
      } catch {
        // Already closed.
      }
    },
  };
}
