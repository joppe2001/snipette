import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CH } from '../shared/types';
import type {
  Project,
  CreateProjectOpts,
  MediaAsset,
  MediaInfo,
  Clip,
  ClipCreate,
  Track,
  TrackCreate,
  Transition,
  TransitionCreate,
  ExportOpts,
  ExportStatus,
  FilePickerOpts,
  CaptionSegment,
  OllamaModel,
  TranslateOpts,
  TranslateProgress,
  AppInfo,
  WebExportAudioOpts,
  WebExportMuxOpts,
  WebExportMuxResult,
  VoiceSaveRecordingOpts,
  VoiceWriteTempOpts,
  VoiceWriteTempResult,
  VoicePromoteOpts,
  TtsGenerateOpts,
  TtsVoice,
} from '../shared/types';

type Unsubscribe = () => void;

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** Snapshot descriptor mirrored from `electron/services/backup.service.ts`. */
export interface SnapshotInfo {
  projectId: string;
  timestamp: number;
  path: string;
  sizeBytes: number;
}

const api = {
  project: {
    list: (): Promise<Project[]> => ipcRenderer.invoke(CH.projectList),
    create: (opts: CreateProjectOpts): Promise<Project> => ipcRenderer.invoke(CH.projectCreate, opts),
    open: (id: string): Promise<Project> => ipcRenderer.invoke(CH.projectOpen, id),
    save: (project: Project): Promise<void> => ipcRenderer.invoke(CH.projectSave, project),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(CH.projectDelete, id),
    duplicate: (id: string): Promise<Project> => ipcRenderer.invoke(CH.projectDuplicate, id),
    rename: (id: string, name: string): Promise<void> =>
      ipcRenderer.invoke(CH.projectRename, id, name),
  },
  media: {
    import: (projectId: string, paths: string[]): Promise<MediaAsset[]> =>
      ipcRenderer.invoke(CH.mediaImport, projectId, paths),
    list: (projectId: string): Promise<MediaAsset[]> => ipcRenderer.invoke(CH.mediaList, projectId),
    generateProxy: (assetId: string): Promise<string> =>
      ipcRenderer.invoke(CH.mediaGenerateProxy, assetId),
    thumbnail: (assetId: string, timeMs: number): Promise<string> =>
      ipcRenderer.invoke(CH.mediaThumbnail, assetId, timeMs),
    waveform: (assetId: string): Promise<number[]> => ipcRenderer.invoke(CH.mediaWaveform, assetId),
    probe: (path: string): Promise<MediaInfo> => ipcRenderer.invoke(CH.mediaProbe, path),
    onAssetUpdated: (cb: (asset: MediaAsset) => void) => on(CH.mediaAssetUpdatedEvent, cb),
    onProxyProgress: (cb: (p: { assetId: string; percent: number }) => void) =>
      on(CH.mediaProxyProgressEvent, cb),
    delete: (assetId: string): Promise<void> => ipcRenderer.invoke(CH.mediaDelete, assetId),
    regenerateProxy: (assetId: string): Promise<void> =>
      ipcRenderer.invoke(CH.mediaRegenerateProxy, assetId),
    detectBeats: (
      assetId: string,
      opts?: { threshold?: number; minIntervalMs?: number },
    ): Promise<number[]> => ipcRenderer.invoke(CH.mediaDetectBeats, assetId, opts),
  },
  timeline: {
    list: (
      projectId: string,
    ): Promise<{ tracks: Track[]; clips: Clip[]; transitions: Transition[] }> =>
      ipcRenderer.invoke(CH.timelineList, projectId),
    addClip: (trackId: string, clip: ClipCreate): Promise<Clip> =>
      ipcRenderer.invoke(CH.timelineAddClip, trackId, clip),
    updateClip: (clipId: string, updates: Partial<Clip>): Promise<Clip> =>
      ipcRenderer.invoke(CH.timelineUpdateClip, clipId, updates),
    deleteClip: (clipId: string): Promise<void> => ipcRenderer.invoke(CH.timelineDeleteClip, clipId),
    splitClip: (clipId: string, atTimeMs: number): Promise<[Clip, Clip]> =>
      ipcRenderer.invoke(CH.timelineSplitClip, clipId, atTimeMs),
    addTrack: (opts: TrackCreate): Promise<Track> => ipcRenderer.invoke(CH.timelineAddTrack, opts),
    deleteTrack: (trackId: string): Promise<void> =>
      ipcRenderer.invoke(CH.timelineDeleteTrack, trackId),
    reorderTrack: (trackId: string, newIndex: number): Promise<void> =>
      ipcRenderer.invoke(CH.timelineReorderTrack, trackId, newIndex),
    reorderTracks: (orderedIds: string[]): Promise<void> =>
      ipcRenderer.invoke(CH.timelineReorderTracks, orderedIds),
    updateTrack: (trackId: string, updates: Partial<Track>): Promise<Track> =>
      ipcRenderer.invoke(CH.timelineUpdateTrack, trackId, updates),
    addTransition: (opts: TransitionCreate): Promise<Transition> =>
      ipcRenderer.invoke(CH.timelineAddTransition, opts),
    updateTransition: (id: string, updates: Partial<Transition>): Promise<Transition> =>
      ipcRenderer.invoke(CH.timelineUpdateTransition, id, updates),
    deleteTransition: (id: string): Promise<void> =>
      ipcRenderer.invoke(CH.timelineDeleteTransition, id),
  },
  export: {
    start: (opts: ExportOpts): Promise<string> => ipcRenderer.invoke(CH.exportStart, opts),
    cancel: (jobId: string): Promise<void> => ipcRenderer.invoke(CH.exportCancel, jobId),
    status: (jobId: string): Promise<ExportStatus> => ipcRenderer.invoke(CH.exportStatus, jobId),
    onProgress: (
      cb: (p: { jobId: string; percent: number; stage: string; etaSeconds: number }) => void,
    ): Unsubscribe => on(CH.exportProgressEvent, cb),
    onComplete: (cb: (p: { jobId: string; outputPath: string; fileSizeBytes: number }) => void) =>
      on(CH.exportCompleteEvent, cb),
    onError: (cb: (p: { jobId: string; error: string }) => void) => on(CH.exportErrorEvent, cb),
  },
  captions: {
    transcribe: (assetId: string): Promise<CaptionSegment[]> =>
      ipcRenderer.invoke(CH.captionsTranscribe, assetId),
    cancel: (): Promise<void> => ipcRenderer.invoke(CH.captionsCancel),
    onProgress: (cb: (p: { percent: number }) => void) => on(CH.captionsProgressEvent, cb),
    translate: (segments: CaptionSegment[], opts: TranslateOpts): Promise<CaptionSegment[]> =>
      ipcRenderer.invoke(CH.captionsTranslate, segments, opts),
    cancelTranslate: (): Promise<void> => ipcRenderer.invoke(CH.captionsTranslateCancel),
    onTranslateProgress: (cb: (p: TranslateProgress) => void) =>
      on(CH.captionsTranslateProgressEvent, cb),
  },
  ollama: {
    available: (): Promise<boolean> => ipcRenderer.invoke(CH.ollamaAvailable),
    listModels: (): Promise<OllamaModel[]> => ipcRenderer.invoke(CH.ollamaListModels),
  },
  settings: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke(CH.settingsGet, key),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke(CH.settingsSet, key, value),
    all: (): Promise<Record<string, string>> => ipcRenderer.invoke(CH.settingsAll),
    reset: (): Promise<void> => ipcRenderer.invoke(CH.settingsReset),
  },
  /** Resolve the absolute filesystem path for a dropped File (Electron 32+ replacement for File.path). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  system: {
    openInFinder: (path: string): Promise<void> => ipcRenderer.invoke(CH.systemOpenInFinder, path),
    showFilePicker: (opts: FilePickerOpts): Promise<string[]> =>
      ipcRenderer.invoke(CH.systemFilePicker, opts),
    getFreeSpace: (): Promise<number> => ipcRenderer.invoke(CH.systemFreeSpace),
    getCacheSize: (): Promise<number> => ipcRenderer.invoke(CH.systemCacheSize),
    clearCache: (): Promise<void> => ipcRenderer.invoke(CH.systemClearCache),
    appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(CH.systemAppInfo),
    whisperAvailable: (): Promise<boolean> => ipcRenderer.invoke(CH.systemWhisperAvailable),
  },
  backup: {
    createSnapshot: (projectId: string): Promise<SnapshotInfo> =>
      ipcRenderer.invoke(CH.backupCreateSnapshot, projectId),
    listSnapshots: (projectId: string): Promise<SnapshotInfo[]> =>
      ipcRenderer.invoke(CH.backupListSnapshots, projectId),
    restoreSnapshot: (snapshotPath: string): Promise<void> =>
      ipcRenderer.invoke(CH.backupRestoreSnapshot, snapshotPath),
    exportBundle: (
      projectId: string,
      outputPath: string,
    ): Promise<{ ok: boolean; sizeBytes: number }> =>
      ipcRenderer.invoke(CH.backupExportBundle, projectId, outputPath),
  },
  webExport: {
    renderAudio: (opts: WebExportAudioOpts): Promise<string | null> =>
      ipcRenderer.invoke(CH.webExportRenderAudio, opts),
    muxFinal: (opts: WebExportMuxOpts): Promise<WebExportMuxResult> =>
      ipcRenderer.invoke(CH.webExportMuxFinal, opts),
    cancel: (projectId: string): Promise<void> =>
      ipcRenderer.invoke(CH.webExportCancel, projectId),
  },
  voice: {
    saveRecording: (opts: VoiceSaveRecordingOpts): Promise<MediaAsset> =>
      ipcRenderer.invoke(CH.voiceSaveRecording, opts),
    writeTemp: (opts: VoiceWriteTempOpts): Promise<VoiceWriteTempResult> =>
      ipcRenderer.invoke(CH.voiceWriteTemp, opts),
    promoteRecording: (opts: VoicePromoteOpts): Promise<MediaAsset> =>
      ipcRenderer.invoke(CH.voicePromoteRecording, opts),
    discardTemp: (tempPath: string): Promise<void> =>
      ipcRenderer.invoke(CH.voiceDiscardTemp, tempPath),
  },
  tts: {
    generate: (opts: TtsGenerateOpts): Promise<MediaAsset> =>
      ipcRenderer.invoke(CH.ttsGenerate, opts),
    listVoices: (): Promise<TtsVoice[]> => ipcRenderer.invoke(CH.ttsListVoices),
  },
};

contextBridge.exposeInMainWorld('snipette', api);

export type SnipetteApi = typeof api;
