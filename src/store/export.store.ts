import { create } from 'zustand';
import type { ExportFormat, ExportQuality } from '@shared/types';

export type ExportPreset = 'tiktok' | 'reels' | 'shorts' | 'instagram-feed' | 'youtube' | 'custom';

export interface ExportConfig {
  preset: ExportPreset;
  quality: ExportQuality;
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  includeAudio: boolean;
  fileName: string;
  outputDir: string;
  /** Override the quality CRF/bitrate with an explicit bitrate in bits per second. */
  targetBitrate?: number;
  /** Two-pass encoding — slower but smaller files at matched quality. */
  twoPass: boolean;
  /** Hardware acceleration mode; 'auto' picks the best available. */
  hwAccel: 'auto' | 'none';
  /** Normalize audio loudness to EBU R128 (-16 LUFS). */
  normalizeLoudness: boolean;
  /** H.264 profile (only applicable to H.264 exports). */
  profile?: 'baseline' | 'main' | 'high';
  /** Output pixel format. yuv420p = 8-bit; yuv420p10le = 10-bit. */
  pixelFormat?: 'yuv420p' | 'yuv420p10le';
  /**
   * Use the new canvas/WebCodecs export engine. When true, ExportModal calls
   * `runWebExport` directly instead of the legacy FFmpeg `export:start` IPC. The new
   * engine renders text + animations using the same code as the live preview, so
   * preview === export by construction. Falls back to the legacy engine on error.
   */
  useNewEngine: boolean;
}

export interface ExportRun {
  jobId: string | null;
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  stage: string;
  etaSeconds: number;
  outputPath: string | null;
  error: string | null;
  fileSizeBytes: number | null;
}

interface ExportStoreState {
  config: ExportConfig;
  run: ExportRun;
  setConfig: (updates: Partial<ExportConfig>) => void;
  setRun: (updates: Partial<ExportRun>) => void;
  reset: () => void;
}

const DEFAULT_CONFIG: ExportConfig = {
  preset: 'tiktok',
  quality: 'high',
  format: 'mp4',
  width: 1080,
  height: 1920,
  fps: 30,
  includeAudio: true,
  fileName: 'snipette-export',
  outputDir: '',
  twoPass: false,
  hwAccel: 'auto',
  normalizeLoudness: false,
  // Phase 7: default to the new engine. The legacy FFmpeg path is one toggle away.
  useNewEngine: true,
};

const DEFAULT_RUN: ExportRun = {
  jobId: null,
  status: 'idle',
  progress: 0,
  stage: '',
  etaSeconds: 0,
  outputPath: null,
  error: null,
  fileSizeBytes: null,
};

export const useExportStore = create<ExportStoreState>((set) => ({
  config: DEFAULT_CONFIG,
  run: DEFAULT_RUN,
  setConfig: (updates) => set((s) => ({ config: { ...s.config, ...updates } })),
  setRun: (updates) => set((s) => ({ run: { ...s.run, ...updates } })),
  reset: () => set({ run: DEFAULT_RUN }),
}));
