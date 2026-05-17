// Types shared between Electron main process and renderer.
// Pure structural types — no runtime imports.

export type Format = '9:16' | '16:9' | '1:1' | 'custom';

export interface Project {
  id: string;
  name: string;
  format: Format;
  width: number;
  height: number;
  fps: number;
  duration_ms: number;
  created_at: number;
  updated_at: number;
  thumbnail_path: string | null;
  settings_json: string | null;
}

export interface CreateProjectOpts {
  name: string;
  format: Format;
  width: number;
  height: number;
  fps: number;
}

export type MediaType = 'video' | 'audio' | 'image';

export interface MediaAsset {
  id: string;
  project_id: string;
  original_path: string;
  proxy_path: string | null;
  thumbnail_path: string | null;
  waveform_path: string | null;
  type: MediaType;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  file_size: number | null;
  codec: string | null;
  created_at: number;
}

export interface MediaInfo {
  type: MediaType;
  duration_ms: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  file_size: number;
  has_audio: boolean;
  has_video: boolean;
}

export type TrackKind = 'video' | 'audio' | 'text' | 'sticker' | 'effect';

export interface Track {
  id: string;
  project_id: string;
  type: TrackKind;
  name: string;
  order_index: number;
  color: string;
  is_visible: number;
  is_locked: number;
  is_muted: number;
  height: number;
}

export interface TrackCreate {
  project_id: string;
  type: TrackKind;
  name?: string;
  color?: string;
}

export interface ColorGrade {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  vibrance: number;
  sharpness: number;
  vignette: number;
  lut_path: string | null;
}

export interface EffectSpec {
  type: string;
  params: Record<string, number | string | boolean>;
}

export interface TextStyle {
  font_family: string;
  font_size: number;
  font_weight: number;
  color: string;
  align: 'left' | 'center' | 'right' | 'justify';
  line_height: number;
  letter_spacing: number;
  stroke_color: string;
  stroke_width: number;
  bg_enabled: boolean;
  bg_color: string;
  bg_padding: number;
  bg_radius: number;
}

export interface TextAnimation {
  preset: string;
  in_ms: number;
  out_ms: number;
  loop: boolean;
}

export interface Clip {
  id: string;
  track_id: string;
  project_id: string;
  asset_id: string | null;
  start_time_ms: number;
  duration_ms: number;
  source_in_ms: number;
  source_out_ms: number;
  position_x: number;
  position_y: number;
  scale_x: number;
  scale_y: number;
  rotation: number;
  opacity: number;
  volume: number;
  speed: number;
  is_reversed: number;
  color_grade_json: string | null;
  effects_json: string | null;
  text_content: string | null;
  text_style_json: string | null;
  text_animation_json: string | null;
  sticker_id: string | null;
  created_at: number;
}

export interface ClipCreate {
  track_id: string;
  project_id: string;
  asset_id?: string | null;
  start_time_ms: number;
  duration_ms: number;
  source_in_ms?: number;
  source_out_ms?: number;
  text_content?: string | null;
  text_style_json?: string | null;
}

export interface Transition {
  id: string;
  project_id: string;
  track_id: string;
  clip_a_id: string;
  clip_b_id: string;
  type: string;
  duration_ms: number;
  params_json: string | null;
}

export interface TransitionCreate {
  project_id: string;
  track_id: string;
  clip_a_id: string;
  clip_b_id: string;
  type: string;
  duration_ms?: number;
}

export interface CaptionWord {
  /** The word text including leading/trailing whitespace from the transcriber. */
  text: string;
  startMs: number;
  endMs: number;
}

export interface CaptionSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  /** Word-level timestamps when the transcriber emitted token offsets. Optional —
   *  renderers should fall back to even-split synthetic word timings if absent. */
  words?: CaptionWord[];
}

export type ExportQuality = 'draft' | 'good' | 'high' | 'best' | 'lossless';
export type ExportFormat = 'mp4' | 'mp4-h265' | 'mov' | 'webm' | 'gif';

export interface ExportOpts {
  project_id: string;
  output_path: string;
  format: ExportFormat;
  quality: ExportQuality;
  width: number;
  height: number;
  fps: number;
  include_audio: boolean;
  /** @deprecated No consumer renders a watermark — kept optional for back-compat
   *  with stored project files that may have it set, but ignored by the export
   *  pipelines (legacy FFmpeg, Studio WebCodecs). */
  include_watermark?: boolean;
  // ---- Advanced encoder options (all optional; sensible defaults if omitted) ----
  /** Override quality-derived bitrate. Bits per second. */
  target_bitrate?: number;
  /** Two-pass encoding produces smaller files at matched quality but takes ~2× as long. */
  two_pass?: boolean;
  /**
   * Hardware acceleration mode. `auto` (default) picks the best available encoder for the
   * platform; `none` forces software encoding. Specific encoder names (`videotoolbox`,
   * `nvenc`, `qsv`, `vaapi`) can be set by the main process when it resolves `auto`.
   */
  hw_accel?: 'auto' | 'none' | 'videotoolbox' | 'nvenc' | 'qsv' | 'vaapi';
  /** Normalize audio loudness to EBU R128 (-16 LUFS) before encoding. */
  normalize_loudness?: boolean;
  /** H.264 profile (only applicable to H.264 exports). */
  profile?: 'baseline' | 'main' | 'high';
  /** Output pixel format. yuv420p = 8-bit (default); yuv420p10le = 10-bit. */
  pixel_format?: 'yuv420p' | 'yuv420p10le';
  /** Optional H.264 level string, e.g. "4.1", "5.1". */
  level?: string;
}

/**
 * Options for the canvas/WebCodecs export path's audio render IPC. The renderer encodes
 * video frames in-browser, then asks main to produce the audio-only file via FFmpeg.
 */
export interface WebExportAudioOpts {
  project_id: string;
  normalize_loudness?: boolean;
}

/**
 * Options for the canvas/WebCodecs export path's final mux IPC. Main writes the encoded
 * video buffer to a temp file, then runs FFmpeg with `-c copy` to mux the audio in.
 */
export interface WebExportMuxOpts {
  output_path: string;
  /** Encoded MP4 bytes from the renderer's mp4-muxer. */
  video_buffer: ArrayBuffer;
  /** Absolute path to an audio file produced by webExport:renderAudio (or null). */
  audio_path: string | null;
}

export interface WebExportMuxResult {
  output_path: string;
  file_size_bytes: number;
}

/**
 * Payload for `voice:saveRecording`. The renderer captures audio with `MediaRecorder`
 * (default codec: webm/opus) and ships the encoded bytes here so main can write them
 * to disk and create a MediaAsset that lives in the library like any imported file.
 */
export interface VoiceSaveRecordingOpts {
  project_id: string;
  /** Encoded audio bytes (e.g. webm/opus). */
  buffer: ArrayBuffer;
  /** File extension — webm | mp4 | wav. Default 'webm'. */
  extension: 'webm' | 'mp4' | 'wav' | 'ogg';
  /** Friendly base filename (no extension, no timestamp). */
  base_name?: string;
  /**
   * Renderer-measured duration in ms. Used as a fallback when ffprobe can't read the
   * duration from the encoded file — which happens for nearly all MediaRecorder webm
   * outputs because they're live streams without a properly-finalized duration header.
   * If both the probe and this field are missing, the asset gets duration 0, which
   * shows up as an invisible zero-width clip on the timeline.
   */
  duration_ms?: number;
}

/** Write a recording to a "pending" temp file. Doesn't create a library row. */
export interface VoiceWriteTempOpts {
  buffer: ArrayBuffer;
  extension: 'webm' | 'mp4' | 'wav' | 'ogg';
  base_name?: string;
}

export interface VoiceWriteTempResult {
  temp_path: string;
  file_size: number;
}

/** Move a pending file into the library and create a MediaAsset row. */
export interface VoicePromoteOpts {
  temp_path: string;
  project_id: string;
  /** Used as fallback when ffprobe can't read duration. */
  duration_ms?: number;
}

/** macOS-only voice handle returned by `say -v ?`. */
export interface TtsVoice {
  name: string;
  locale: string;
}

/**
 * Generate a single TTS clip and register it as a MediaAsset. Renderer holds onto the
 * returned asset and creates a clip pointing at it.
 */
export interface TtsGenerateOpts {
  project_id: string;
  text: string;
  voice?: string;
  /** Words per minute. macOS `say` accepts ~90–360. */
  rate?: number;
  /** Friendly base name baked into the saved file. */
  base_name?: string;
}

export type ExportStage =
  | 'queued'
  | 'preparing'
  | 'encoding'
  | 'mixing-audio'
  | 'writing-file'
  | 'done'
  | 'error'
  | 'cancelled';

export interface ExportStatus {
  job_id: string;
  project_id: string;
  status: ExportStage;
  progress: number;
  stage_label: string;
  output_path: string;
  started_at: number;
  completed_at: number | null;
  error: string | null;
}

export interface FilePickerOpts {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
  multi?: boolean;
  directory?: boolean;
  save?: boolean;
  defaultFileName?: string;
}

// All IPC channel names in one place so the bridge stays typed end-to-end.
export const CH = {
  // Projects
  projectList: 'project:list',
  projectCreate: 'project:create',
  projectOpen: 'project:open',
  projectSave: 'project:save',
  projectDelete: 'project:delete',
  projectDuplicate: 'project:duplicate',
  projectRename: 'project:rename',
  // Media
  mediaImport: 'media:import',
  mediaGenerateProxy: 'media:generateProxy',
  mediaThumbnail: 'media:thumbnail',
  mediaWaveform: 'media:waveform',
  mediaProbe: 'media:probe',
  mediaList: 'media:list',
  mediaAssetUpdatedEvent: 'media:assetUpdated',
  mediaProxyProgressEvent: 'media:proxyProgress',
  mediaDelete: 'media:delete',
  mediaRegenerateProxy: 'media:regenerateProxy',
  mediaDetectBeats: 'media:detectBeats',
  // Timeline
  timelineList: 'timeline:list',
  timelineAddClip: 'timeline:addClip',
  timelineUpdateClip: 'timeline:updateClip',
  timelineDeleteClip: 'timeline:deleteClip',
  timelineSplitClip: 'timeline:splitClip',
  timelineAddTrack: 'timeline:addTrack',
  timelineDeleteTrack: 'timeline:deleteTrack',
  timelineReorderTrack: 'timeline:reorderTrack',
  timelineReorderTracks: 'timeline:reorderTracks',
  timelineUpdateTrack: 'timeline:updateTrack',
  timelineAddTransition: 'timeline:addTransition',
  timelineUpdateTransition: 'timeline:updateTransition',
  timelineDeleteTransition: 'timeline:deleteTransition',
  // Export
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportStatus: 'export:getStatus',
  exportProgressEvent: 'export:progress',
  exportCompleteEvent: 'export:complete',
  exportErrorEvent: 'export:error',
  // Captions
  captionsTranscribe: 'captions:transcribe',
  captionsCancel: 'captions:cancel',
  captionsProgressEvent: 'captions:progress',
  // Settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsAll: 'settings:getAll',
  settingsReset: 'settings:reset',
  // System
  systemOpenInFinder: 'system:openInFinder',
  systemFilePicker: 'system:showFilePicker',
  systemFreeSpace: 'system:getFreeSpace',
  systemCacheSize: 'system:getCacheSize',
  systemClearCache: 'system:clearCache',
  systemAppInfo: 'system:appInfo',
  systemWhisperAvailable: 'system:whisperAvailable',
  // Backup
  backupCreateSnapshot: 'backup:createSnapshot',
  backupListSnapshots: 'backup:listSnapshots',
  backupRestoreSnapshot: 'backup:restoreSnapshot',
  backupExportBundle: 'backup:exportBundle',
  // Web export (canvas + WebCodecs pipeline). Video is encoded in the renderer; audio
  // is rendered through FFmpeg in main and muxed in at the end.
  webExportRenderAudio: 'webExport:renderAudio',
  webExportMuxFinal: 'webExport:muxFinal',
  webExportCancel: 'webExport:cancel',
  // Voice studio — captured audio buffer is shipped from renderer; main writes it to
  // disk under the project's media folder and registers it as a MediaAsset.
  voiceSaveRecording: 'voice:saveRecording',
  // Two-step save: writeTemp lands the blob in `recordings/pending/` for safety on
  // Stop, then promoteRecording moves it into `recordings/` proper and creates the
  // library row only when the user clicks Save. discardTemp cleans up unsaved files.
  voiceWriteTemp: 'voice:writeTemp',
  voicePromoteRecording: 'voice:promoteRecording',
  voiceDiscardTemp: 'voice:discardTemp',
  // Text-to-speech — used by the Dialogue panel to auto-generate per-line voice clips.
  ttsGenerate: 'tts:generate',
  ttsListVoices: 'tts:listVoices',
} as const;

export type ChannelName = (typeof CH)[keyof typeof CH];

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  user_data_path: string;
  cache_path: string;
}
