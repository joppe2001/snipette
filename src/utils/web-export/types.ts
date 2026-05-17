import type {
  Clip,
  ExportFormat,
  ExportQuality,
  MediaAsset,
  Project,
  Track,
  Transition,
} from '@shared/types';

/** Top-level opts handed to {@link runWebExport}. Mirrors the legacy ExportOpts shape. */
export interface WebExportOpts {
  project: Project;
  tracks: Track[];
  clips: Clip[];
  transitions: Transition[];
  assets: MediaAsset[];
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  format: ExportFormat;
  quality: ExportQuality;
  includeAudio: boolean;
  /** Override the quality-derived bitrate. Bits per second. */
  targetBitrate?: number;
  /** EBU R128 loudness normalization on the audio chain. */
  normalizeLoudness?: boolean;
  /**
   * Width (CSS pixels) of the preview canvas at the moment the export was kicked off.
   * Used to scale text + position offsets from preview-pixel space into export-pixel
   * space, so Studio output visually matches the editor preview. Falls back to 1:1
   * when not provided.
   */
  previewWidth?: number;
}

export interface WebExportProgress {
  /** 0..1 */
  fraction: number;
  /** Human-readable stage label, e.g. "Encoding video", "Mixing audio". */
  stage: string;
  /** Best-effort ETA in seconds; 0 when unknown. */
  etaSeconds: number;
}

export interface WebExportResult {
  outputPath: string;
  fileSizeBytes: number;
}

/**
 * Translates ExportQuality into a video bitrate in bits per second. These are caps the
 * WebCodecs `VideoEncoder` aims for; the encoder spends less when the content doesn't
 * need it. "Lossless" is aspirational — true H.264 lossless requires CRF 0 which the
 * platform encoder doesn't expose; we instead set a very high bitrate that virtually
 * eliminates compression artefacts at 1080p.
 */
export const QUALITY_BITRATE: Record<ExportQuality, number> = {
  draft: 3_000_000,
  good: 8_000_000,
  high: 16_000_000,
  best: 32_000_000,
  lossless: 120_000_000,
};

/**
 * Map an {@link ExportFormat} to a WebCodecs `codec` string. `null` means the format isn't
 * supported by the canvas pipeline and we must fall back to the legacy FFmpeg export.
 */
export function videoCodecFor(format: ExportFormat): {
  webCodec: string;
  muxerCodec: 'avc' | 'hevc' | 'vp9' | 'av1';
} | null {
  switch (format) {
    case 'mp4':
    case 'mov':
      // High Profile, Level 5.1 — supports up to 4K @ 60fps. We pin a level so the encoder
      // doesn't pick something the muxer can't accept.
      return { webCodec: 'avc1.640033', muxerCodec: 'avc' };
    case 'mp4-h265':
      // Main profile HEVC. Hardware availability is platform-dependent — VideoEncoder.isConfigSupported
      // is the safety net.
      return { webCodec: 'hvc1.1.6.L120.90', muxerCodec: 'hevc' };
    default:
      return null;
  }
}
