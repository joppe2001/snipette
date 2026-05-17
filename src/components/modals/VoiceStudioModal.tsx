import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useEditorStore } from '@/store/editor.store';
import { useProjectStore } from '@/store/project.store';
import { useTimelineStore } from '@/store/timeline.store';
import { Icons } from '@/components/ui/icons';
import { Slider } from '@/components/ui/Slider';
import {
  createVoiceRecorder,
  extensionForMime,
  linearToDb,
  listInputDevices,
  sampleLevels,
  type VoiceRecorderHandle,
} from '@/utils/voice/recorder';
import { createVoiceMonitor, type MonitorMode, type VoiceMonitor } from '@/utils/voice/monitor';
import type { Clip, ClipCreate, MediaAsset } from '@shared/types';

type SessionState = 'idle' | 'recording' | 'paused' | 'reviewing';
type Tab = 'record' | 'punch-in';

/**
 * Two-step save flow.
 *  - `idle`: pre-stop (no blob yet)
 *  - `persisting`: writing the pending temp file
 *  - `pending`: temp file is on disk in `recordings/pending/`. Library row NOT created
 *    yet — waiting for user to click Save (or Discard).
 *  - `library`: user clicked Save, the file is now in `recordings/` and has a DB row.
 *  - `fallback`: IPC didn't work. Blob was downloaded to the user's Downloads folder.
 *    `downloadFired` tracks whether the browser-native download was actually triggered.
 */
type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'persisting' }
  | { kind: 'pending'; tempPath: string; fileSize: number }
  | { kind: 'library'; asset: MediaAsset }
  | { kind: 'fallback'; error: string; downloadFired: boolean };

export function VoiceStudioModal(): JSX.Element {
  const open = useEditorStore((s) => s.voiceStudioOpen);
  const close = useEditorStore((s) => s.closeVoiceStudio);
  const pushToast = useEditorStore((s) => s.pushToast);
  const project = useProjectStore((s) => s.activeProject);
  const upsertAsset = useProjectStore((s) => s.upsertAsset);
  const tracks = useTimelineStore((s) => s.tracks);
  const clips = useTimelineStore((s) => s.clips);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const playheadMs = useTimelineStore((s) => s.playheadMs);
  const upsertTrack = useTimelineStore((s) => s.upsertTrack);
  const addClipLocal = useTimelineStore((s) => s.addClip);

  const selectedAudioClip = useMemo<Clip | null>(() => {
    if (!selectedClipIds.length) return null;
    const c = clips.find((x) => x.id === selectedClipIds[0]);
    if (!c) return null;
    const t = tracks.find((tr) => tr.id === c.track_id);
    if (!t || t.type !== 'audio') return null;
    return c;
  }, [selectedClipIds, clips, tracks]);

  const [tab, setTab] = useState<Tab>('record');
  const [session, setSession] = useState<SessionState>('idle');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [monitorMode, setMonitorMode] = useState<MonitorMode>('off');
  const [monitorVolume, setMonitorVolume] = useState(0.7);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levelDb, setLevelDb] = useState(-Infinity);
  const [peakDb, setPeakDb] = useState(-Infinity);
  const [recording, setRecording] = useState<{ blob: Blob; durationMs: number; mimeType: string } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [autoAddToTimeline, setAutoAddToTimeline] = useState(true);
  const [addedToTimeline, setAddedToTimeline] = useState(false);
  // The save IPC bridge isn't always loaded (preload reload requires Electron restart).
  // Probed once at modal open so we can show a persistent warning rather than failing
  // silently when the user clicks Save.
  const ipcAvailable = useMemo(
    () =>
      typeof window.snipette?.voice?.writeTemp === 'function' &&
      typeof window.snipette?.voice?.promoteRecording === 'function',
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  );

  const recorderRef = useRef<VoiceRecorderHandle | null>(null);
  const monitorRef = useRef<VoiceMonitor | null>(null);
  const sessionStartRef = useRef<number>(0);
  const pausedTotalRef = useRef<number>(0);
  const pausedAtRef = useRef<number | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Reset when the modal opens/closes.
  useEffect(() => {
    if (!open) {
      void teardown();
      setSession('idle');
      setRecording(null);
      setPermissionError(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setElapsedMs(0);
      setLevelDb(-Infinity);
      setPeakDb(-Infinity);
      pausedTotalRef.current = 0;
      pausedAtRef.current = null;
      setSaveStatus({ kind: 'idle' });
      setAddedToTimeline(false);
      return;
    }
    // First open: jump straight to punch-in tab if a compatible clip is selected.
    if (selectedAudioClip) setTab('punch-in');
    void boot();
    return () => {
      void teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Refresh the input-device list once permission is granted (labels are blank until then).
  useEffect(() => {
    if (!open) return;
    const refresh = async () => {
      const ds = await listInputDevices();
      setDevices(ds);
      if (!deviceId && ds.length) setDeviceId(ds[0].deviceId);
    };
    void refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Drive the level meter + waveform via rAF while a recorder exists.
  useEffect(() => {
    if (!recorderRef.current) return;
    let raf = 0;
    const tick = () => {
      const r = recorderRef.current;
      if (!r) return;
      const { rms, peak, samples } = sampleLevels(r.analyser);
      setLevelDb(linearToDb(rms));
      setPeakDb(linearToDb(peak));
      drawWaveform(waveformCanvasRef.current, samples);
      // Update elapsed only while actively recording.
      if (session === 'recording') {
        setElapsedMs(performance.now() - sessionStartRef.current - pausedTotalRef.current);
      } else if (session === 'paused' && pausedAtRef.current != null) {
        // Hold the displayed elapsed where pause started.
        const display = pausedAtRef.current - sessionStartRef.current - pausedTotalRef.current;
        setElapsedMs(display);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [session, open, recording]);

  const boot = useCallback(async () => {
    if (recorderRef.current) return;
    try {
      const handle = await createVoiceRecorder({
        deviceId: deviceId || undefined,
        rawCapture: true,
      });
      recorderRef.current = handle;
      monitorRef.current = createVoiceMonitor({
        audioCtx: handle.audioCtx,
        source: handle.source,
        initialMode: monitorMode,
        initialVolume: monitorVolume,
      });
      setPermissionError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPermissionError(`Microphone unavailable: ${msg}`);
    }
  }, [deviceId, monitorMode, monitorVolume]);

  const teardown = useCallback(async () => {
    if (recorderRef.current && (session === 'recording' || session === 'paused')) {
      try {
        await recorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    monitorRef.current?.dispose();
    monitorRef.current = null;
    recorderRef.current?.dispose();
    recorderRef.current = null;
  }, [session]);

  // Reconfigure when the user picks a different device.
  useEffect(() => {
    if (!open || !recorderRef.current) return;
    // Tear down the current stream and re-create with the new device.
    void (async () => {
      const wasRecording = session;
      await teardown();
      await boot();
      // After device swap, push monitor mode/volume into the fresh monitor instance.
      monitorRef.current?.setMode(monitorMode);
      monitorRef.current?.setVolume(monitorVolume);
      if (wasRecording !== 'idle') setSession('idle');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  useEffect(() => {
    monitorRef.current?.setMode(monitorMode);
  }, [monitorMode]);
  useEffect(() => {
    monitorRef.current?.setVolume(monitorVolume);
  }, [monitorVolume]);

  const startRecording = useCallback(() => {
    const r = recorderRef.current;
    if (!r) return;
    r.start();
    sessionStartRef.current = performance.now();
    pausedTotalRef.current = 0;
    pausedAtRef.current = null;
    setRecording(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setSession('recording');
  }, [previewUrl]);

  const pauseRecording = useCallback(() => {
    const r = recorderRef.current;
    if (!r || session !== 'recording') return;
    r.pause();
    pausedAtRef.current = performance.now();
    setSession('paused');
  }, [session]);

  const resumeRecording = useCallback(() => {
    const r = recorderRef.current;
    if (!r || session !== 'paused' || pausedAtRef.current == null) return;
    pausedTotalRef.current += performance.now() - pausedAtRef.current;
    pausedAtRef.current = null;
    r.resume();
    setSession('recording');
  }, [session]);

  /**
   * Browser-native download as a hard safety net — fires `<a download>` so the blob
   * lands in the user's Downloads folder regardless of whether our IPC is reachable.
   * Must be triggered from a user gesture; we invoke it from auto-save (right after a
   * Stop click) and from explicit Download buttons.
   */
  const triggerLocalDownload = useCallback(
    (rec: { blob: Blob; mimeType: string }, label = 'voice'): boolean => {
      try {
        const ext = extensionForMime(rec.mimeType);
        const url = URL.createObjectURL(rec.blob);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const a = document.createElement('a');
        a.href = url;
        a.download = `${label}-${stamp}.${ext}`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          a.remove();
          URL.revokeObjectURL(url);
        }, 2_000);
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  /**
   * Write a "pending" safety copy to disk the moment recording stops. NO library row
   * is created here — that happens later when the user clicks Save. If the IPC isn't
   * available, fall back to a browser-native download so the file still hits disk.
   */
  const persistTemp = useCallback(
    async (rec: { blob: Blob; mimeType: string; durationMs: number }): Promise<void> => {
      setSaveStatus({ kind: 'persisting' });
      if (!ipcAvailable) {
        const downloaded = triggerLocalDownload(rec, 'voice-rescue');
        setSaveStatus({
          kind: 'fallback',
          error:
            'Save bridge unavailable. Restart Snipette so future takes can save to the library. Your recording has been downloaded to your Downloads folder.',
          downloadFired: downloaded,
        });
        return;
      }
      try {
        const ext = extensionForMime(rec.mimeType);
        const baseName = tab === 'punch-in' && selectedAudioClip ? 'punch_in' : 'voice';
        const buffer = await rec.blob.arrayBuffer();
        const result = await window.snipette.voice.writeTemp({
          buffer,
          extension: ext,
          base_name: baseName,
        });
        setSaveStatus({ kind: 'pending', tempPath: result.temp_path, fileSize: result.file_size });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const downloaded = triggerLocalDownload(rec, 'voice-fallback');
        setSaveStatus({
          kind: 'fallback',
          error: `Couldn't write a safety copy: ${msg}`,
          downloadFired: downloaded,
        });
      }
    },
    [ipcAvailable, tab, selectedAudioClip, triggerLocalDownload],
  );

  /**
   * Promote the pending temp file into the library. Triggered explicitly by the user
   * clicking the "Save" button — never automatically.
   */
  const saveToLibrary = useCallback(async (): Promise<void> => {
    if (saveStatus.kind !== 'pending' || !project) return;
    try {
      const asset = await window.snipette.voice.promoteRecording({
        temp_path: saveStatus.tempPath,
        project_id: project.id,
        duration_ms: recording?.durationMs,
      });
      upsertAsset(asset);
      setSaveStatus({ kind: 'library', asset });
    } catch (err) {
      pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to save to library',
      });
    }
  }, [saveStatus, project, recording, upsertAsset, pushToast]);

  const stopRecording = useCallback(async () => {
    const r = recorderRef.current;
    if (!r || (session !== 'recording' && session !== 'paused')) return;
    const result = await r.stop();
    setRecording(result);
    setSession('reviewing');
    const url = URL.createObjectURL(result.blob);
    setPreviewUrl(url);
    // Write the SAFETY COPY only — library promotion happens when the user clicks Save.
    void persistTemp(result);
  }, [session, persistTemp]);

  const discardRecording = useCallback(async () => {
    // Clean up whichever stage the recording reached:
    //  - pending → delete the temp file (never made it to library)
    //  - library → delete the library row + file
    if (saveStatus.kind === 'pending') {
      try {
        await window.snipette.voice.discardTemp(saveStatus.tempPath);
      } catch {
        // best effort
      }
    } else if (saveStatus.kind === 'library') {
      try {
        await window.snipette.media.delete(saveStatus.asset.id);
        useProjectStore.getState().removeAsset(saveStatus.asset.id);
      } catch {
        // best effort
      }
    }
    setRecording(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setElapsedMs(0);
    setSession('idle');
    setSaveStatus({ kind: 'idle' });
    setAddedToTimeline(false);
  }, [previewUrl, saveStatus]);

  const retryLibrarySave = useCallback(async () => {
    if (!recording) return;
    await persistTemp(recording);
  }, [recording, persistTemp]);

  const manualDownload = useCallback(() => {
    if (!recording) return;
    const ok = triggerLocalDownload(recording, 'voice-manual');
    pushToast({
      kind: ok ? 'success' : 'error',
      message: ok ? 'Recording downloaded' : 'Download failed — try saving via right-click on the audio player',
    });
  }, [recording, triggerLocalDownload, pushToast]);

  const addToTimeline = useCallback(async () => {
    if (saveStatus.kind !== 'library') return;
    // Belt-and-suspenders: webm from MediaRecorder has no duration header, so the
    // asset's `duration_ms` may have come back as 0 if ffprobe couldn't parse it. Use
    // the renderer-measured duration as a fallback so the clip never lands as 0-wide.
    const fromAsset = saveStatus.asset.duration_ms ?? 0;
    const safeDuration = fromAsset > 0 ? fromAsset : recording?.durationMs ?? 0;
    const assetForClip = { ...saveStatus.asset, duration_ms: safeDuration };
    try {
      await addRecordedClip(assetForClip);
      setAddedToTimeline(true);
      pushToast({ kind: 'success', message: 'Added to timeline' });
    } catch (err) {
      pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to add to timeline',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveStatus, recording, pushToast]);

  // Auto-add to timeline on successful save when the user opted in, or always for
  // punch-in mode (the whole point of which is to replace the selected clip).
  useEffect(() => {
    if (saveStatus.kind !== 'library' || addedToTimeline) return;
    if (!autoAddToTimeline && tab !== 'punch-in') return;
    void addToTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveStatus]);

  const addRecordedClip = useCallback(
    async (asset: MediaAsset) => {
      if (!project) return;
      // Punch-in: replace selected clip on its own track at its own start.
      // Standalone: drop on the first audio track at the playhead; create one if missing.
      let targetTrack = selectedAudioClip
        ? tracks.find((t) => t.id === selectedAudioClip.track_id)
        : tracks.find((t) => t.type === 'audio');
      if (!targetTrack) {
        targetTrack = await window.snipette.timeline.addTrack({
          project_id: project.id,
          type: 'audio',
        });
        upsertTrack(targetTrack);
      }
      const isPunchIn = tab === 'punch-in' && !!selectedAudioClip;
      const startMs = isPunchIn ? selectedAudioClip!.start_time_ms : playheadMs;
      const dur = asset.duration_ms ?? 0;
      // Punch-in: delete the original first so the new take stands alone in that slot.
      if (isPunchIn && selectedAudioClip) {
        useTimelineStore.getState().pushHistory();
        await window.snipette.timeline.deleteClip(selectedAudioClip.id).catch(() => undefined);
        useTimelineStore.getState().removeClip(selectedAudioClip.id);
      }
      const create: ClipCreate = {
        track_id: targetTrack.id,
        project_id: project.id,
        asset_id: asset.id,
        start_time_ms: Math.max(0, startMs),
        duration_ms: dur,
        source_in_ms: 0,
        source_out_ms: dur,
      };
      const clip = await window.snipette.timeline.addClip(targetTrack.id, create);
      addClipLocal(clip);
    },
    [project, tracks, tab, selectedAudioClip, playheadMs, addClipLocal, upsertTrack],
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(10,10,12,0.85)',
            backdropFilter: 'blur(12px)',
            zIndex: 1100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <motion.div
            initial={{ y: 12, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 12, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            style={{
              width: 'min(720px, 100%)',
              maxHeight: '90vh',
              overflow: 'auto',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 14,
              boxShadow: '0 32px 80px rgba(0,0,0,0.5)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <Header onClose={() => {
              // Block close if recording or save is still in flight; warn if we'd be
              // tossing an unsaved take.
              if (session === 'recording' || session === 'paused') {
                if (!window.confirm('Recording is in progress. Stop and discard?')) return;
              } else if (saveStatus.kind === 'persisting') {
                if (!window.confirm('Writing safety copy. Close anyway?')) return;
              } else if (saveStatus.kind === 'pending') {
                if (!window.confirm('You have a recording that hasn\'t been saved to the library yet. Close and discard it?')) return;
                // User opted to discard — clean up the temp file.
                void window.snipette.voice.discardTemp(saveStatus.tempPath).catch(() => undefined);
              } else if (saveStatus.kind === 'fallback' && !saveStatus.downloadFired) {
                if (!window.confirm('Your recording was NOT saved. Close anyway? (Click cancel and use Download to save it.)')) return;
              }
              close();
            }} />

            <Tabs
              tab={tab}
              setTab={setTab}
              hasSelectedAudioClip={!!selectedAudioClip}
            />

            <div style={{ padding: '18px 24px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              {!ipcAvailable && (
                <div
                  style={{
                    padding: '10px 12px',
                    background: 'rgba(242, 168, 58, 0.10)',
                    border: '1px solid rgba(242, 168, 58, 0.4)',
                    borderRadius: 8,
                    fontSize: 12,
                    color: 'var(--orange, #F2A83A)',
                  }}
                >
                  <b>Heads up:</b> the voice-save bridge isn't loaded. Recording still works — any take will auto-download to your Downloads folder when you press Stop. Quit Snipette and re-run the dev command to enable in-library saving.
                </div>
              )}
              {permissionError && (
                <div
                  style={{
                    padding: '10px 12px',
                    background: 'rgba(242, 58, 94, 0.08)',
                    border: '1px solid rgba(242, 58, 94, 0.3)',
                    borderRadius: 8,
                    fontSize: 12,
                    color: 'var(--red-alert, #F23A5E)',
                  }}
                >
                  {permissionError}
                </div>
              )}

              {tab === 'punch-in' && selectedAudioClip && (
                <PunchInBanner clip={selectedAudioClip} />
              )}

              <DevicePicker
                devices={devices}
                value={deviceId}
                onChange={setDeviceId}
                disabled={session === 'recording' || session === 'paused'}
              />

              <MonitorPanel
                mode={monitorMode}
                setMode={setMonitorMode}
                volume={monitorVolume}
                setVolume={setMonitorVolume}
              />

              <LevelStrip rmsDb={levelDb} peakDb={peakDb} session={session} />
              <Waveform canvasRef={waveformCanvasRef} />

              <Timer elapsedMs={elapsedMs} session={session} />

              <Transport
                session={session}
                onStart={startRecording}
                onPause={pauseRecording}
                onResume={resumeRecording}
                onStop={stopRecording}
                disabled={!!permissionError}
              />

              {session === 'reviewing' && recording && previewUrl && (
                <Review
                  previewUrl={previewUrl}
                  durationMs={recording.durationMs}
                  saveStatus={saveStatus}
                  addedToTimeline={addedToTimeline}
                  autoAdd={autoAddToTimeline}
                  setAutoAdd={setAutoAddToTimeline}
                  onSave={saveToLibrary}
                  onRetrySave={retryLibrarySave}
                  onManualDownload={manualDownload}
                  onAddToTimeline={addToTimeline}
                  onDiscard={discardRecording}
                  tab={tab}
                />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ----------------------------------------------------------------------------
// Subcomponents
// ----------------------------------------------------------------------------

function Header({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{
        padding: '18px 24px 14px',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: 'rgba(242, 58, 94, 0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--red-alert, #F23A5E)',
        }}
      >
        <Icons.Volume size={18} />
      </div>
      <div style={{ flex: 1 }}>
        <div className="display" style={{ fontSize: 20, letterSpacing: '0.06em' }}>VOICE STUDIO</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          Record + preview a take, then save it straight to the library.
        </div>
      </div>
      <button className="sn-icon-btn" onClick={onClose} aria-label="Close">
        <Icons.X size={14} />
      </button>
    </div>
  );
}

function Tabs({
  tab,
  setTab,
  hasSelectedAudioClip,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  hasSelectedAudioClip: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: '12px 24px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <TabBtn label="Record" active={tab === 'record'} onClick={() => setTab('record')} />
      <TabBtn
        label="Punch-in"
        active={tab === 'punch-in'}
        onClick={() => hasSelectedAudioClip && setTab('punch-in')}
        disabled={!hasSelectedAudioClip}
        hint={!hasSelectedAudioClip ? 'Select an audio clip first' : undefined}
      />
    </div>
  );
}

function TabBtn({
  label,
  active,
  onClick,
  disabled,
  hint,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={hint}
      style={{
        padding: '8px 14px',
        fontSize: 12,
        fontWeight: 600,
        background: 'transparent',
        color: active ? 'var(--accent-primary)' : disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
        borderBottom: `2px solid ${active ? 'var(--accent-primary)' : 'transparent'}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {label}
    </button>
  );
}

function PunchInBanner({ clip }: { clip: Clip }) {
  return (
    <div
      style={{
        padding: '10px 12px',
        background: 'rgba(200, 242, 58, 0.06)',
        border: '1px solid rgba(200, 242, 58, 0.3)',
        borderRadius: 8,
        fontSize: 11.5,
        color: 'var(--accent-primary)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Icons.Lock size={11} />
      <span>
        Punch-in target: clip starting at <b>{formatMs(clip.start_time_ms)}</b> · saved take will be placed on the same track at the same time.
      </span>
    </div>
  );
}

function DevicePicker({
  devices,
  value,
  onChange,
  disabled,
}: {
  devices: MediaDeviceInfo[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <Field label="Input device">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          width: '100%',
          padding: '8px 10px',
          fontSize: 12,
          background: 'var(--bg-base)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 6,
          color: 'var(--text-primary)',
          appearance: 'none',
        }}
      >
        {devices.length === 0 && <option value="">(no input devices found)</option>}
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Microphone (${d.deviceId.slice(0, 8)})`}
          </option>
        ))}
      </select>
    </Field>
  );
}

function MonitorPanel({
  mode,
  setMode,
  volume,
  setVolume,
}: {
  mode: MonitorMode;
  setMode: (m: MonitorMode) => void;
  volume: number;
  setVolume: (v: number) => void;
}) {
  return (
    <Field
      label="Monitoring"
      hint={mode !== 'off' ? '⚠ Use headphones — speaker output can feedback into the mic.' : 'Off · no playback while recording.'}
    >
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {(['off', 'direct', 'with-fx'] as MonitorMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={pillStyle(mode === m)}
          >
            {m === 'off' ? 'Off' : m === 'direct' ? 'Direct' : 'With FX'}
          </button>
        ))}
      </div>
      {mode !== 'off' && (
        <Slider value={volume} min={0} max={1} onChange={setVolume} />
      )}
    </Field>
  );
}

function LevelStrip({
  rmsDb,
  peakDb,
  session,
}: {
  rmsDb: number;
  peakDb: number;
  session: SessionState;
}) {
  // Map -60..0 dB → 0..1 for the bar fill.
  const map = (db: number): number => {
    if (db === -Infinity) return 0;
    return Math.max(0, Math.min(1, (db + 60) / 60));
  };
  const rms = map(rmsDb);
  const peak = map(peakDb);
  const clipping = peakDb > -1;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-secondary)', marginBottom: 4 }}>
        <span>Level</span>
        <span className="mono" style={{ color: clipping ? 'var(--red-alert, #F23A5E)' : 'var(--text-secondary)' }}>
          {rmsDb === -Infinity ? '-∞' : rmsDb.toFixed(1)} dB
          {clipping ? ' · CLIP' : ''}
        </span>
      </div>
      <div
        style={{
          position: 'relative',
          height: 8,
          background: 'var(--bg-base)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: `${rms * 100}%`,
            background: `linear-gradient(90deg, var(--accent-primary) 0%, var(--accent-primary) 60%, var(--orange, #F2A83A) 80%, var(--red-alert, #F23A5E) 100%)`,
            transition: session === 'recording' ? 'none' : 'width .15s',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${peak * 100}%`,
            width: 2,
            background: clipping ? 'var(--red-alert, #F23A5E)' : 'rgba(255,255,255,0.7)',
          }}
        />
      </div>
    </div>
  );
}

function Waveform({ canvasRef }: { canvasRef: React.MutableRefObject<HTMLCanvasElement | null> }) {
  return (
    <div
      style={{
        height: 80,
        background: 'var(--bg-base)',
        borderRadius: 8,
        border: '1px solid var(--border-subtle)',
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        width={680}
        height={80}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
}

function Timer({ elapsedMs, session }: { elapsedMs: number; session: SessionState }) {
  const isRecording = session === 'recording';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: isRecording ? 'var(--red-alert, #F23A5E)' : 'var(--text-muted)',
          boxShadow: isRecording ? '0 0 12px var(--red-alert, #F23A5E)' : 'none',
          animation: isRecording ? 'sn-pulse-soft 1.2s ease-in-out infinite' : 'none',
        }}
      />
      <div className="mono" style={{ fontSize: 28, letterSpacing: '0.06em', color: 'var(--text-primary)' }}>
        {formatMs(Math.max(0, elapsedMs))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
        {session === 'recording' && 'Recording'}
        {session === 'paused' && 'Paused'}
        {session === 'idle' && 'Ready'}
        {session === 'reviewing' && 'Review'}
      </div>
    </div>
  );
}

function Transport({
  session,
  onStart,
  onPause,
  onResume,
  onStop,
  disabled,
}: {
  session: SessionState;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {session === 'idle' || session === 'reviewing' ? (
        <button
          className="sn-btn-primary"
          style={{ padding: '10px 18px', fontSize: 13, gap: 8 }}
          onClick={onStart}
          disabled={disabled}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#0A0A0C',
              display: 'inline-block',
            }}
          />
          {session === 'reviewing' ? 'Record another take' : 'Record'}
        </button>
      ) : (
        <>
          {session === 'recording' ? (
            <button className="sn-btn-ghost" onClick={onPause} style={{ padding: '10px 16px', fontSize: 12 }}>
              <Icons.Pause size={12} /> Pause
            </button>
          ) : (
            <button className="sn-btn-ghost" onClick={onResume} style={{ padding: '10px 16px', fontSize: 12 }}>
              <Icons.Play size={12} /> Resume
            </button>
          )}
          <button
            onClick={onStop}
            style={{
              padding: '10px 18px',
              fontSize: 12,
              background: 'var(--red-alert, #F23A5E)',
              color: '#fff',
              borderRadius: 8,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ width: 10, height: 10, background: '#fff' }} /> Stop
          </button>
        </>
      )}
    </div>
  );
}

function Review({
  previewUrl,
  durationMs,
  saveStatus,
  addedToTimeline,
  autoAdd,
  setAutoAdd,
  onSave,
  onRetrySave,
  onManualDownload,
  onAddToTimeline,
  onDiscard,
  tab,
}: {
  previewUrl: string;
  durationMs: number;
  saveStatus: SaveStatus;
  addedToTimeline: boolean;
  autoAdd: boolean;
  setAutoAdd: (v: boolean) => void;
  onSave: () => void;
  onRetrySave: () => void;
  onManualDownload: () => void;
  onAddToTimeline: () => void;
  onDiscard: () => void;
  tab: Tab;
}) {
  const persisting = saveStatus.kind === 'persisting';
  const isPending = saveStatus.kind === 'pending';
  const inLibrary = saveStatus.kind === 'library';
  const inFallback = saveStatus.kind === 'fallback';

  return (
    <div
      style={{
        padding: 14,
        background: 'var(--bg-base)',
        borderRadius: 10,
        border: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="display" style={{ fontSize: 14, letterSpacing: '0.06em' }}>REVIEW</div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          {formatMs(durationMs)}
        </div>
      </div>

      {/* Save-status banner. Always visible after stop so the user always knows where their take is. */}
      {persisting && (
        <StatusBanner kind="info">Writing safety copy…</StatusBanner>
      )}
      {isPending && (
        <StatusBanner kind="info">
          Safety copy on disk · click <b>Save</b> to add to your library, or <b>Discard</b> to delete.
        </StatusBanner>
      )}
      {inLibrary && (
        <StatusBanner kind="success">
          Saved to library {addedToTimeline ? '· added to timeline' : ''}
        </StatusBanner>
      )}
      {inFallback && (
        <StatusBanner kind="warn">
          <div style={{ marginBottom: 4 }}>{saveStatus.error}</div>
          {!saveStatus.downloadFired && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              The auto-download didn't fire. Use the <b>Download</b> button below to save the take manually before closing this window.
            </div>
          )}
        </StatusBanner>
      )}

      <audio src={previewUrl} controls style={{ width: '100%' }} />

      {tab === 'record' && !inLibrary && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={autoAdd}
            onChange={(e) => setAutoAdd(e.target.checked)}
          />
          Also add to the timeline at the playhead
        </label>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {/* Manual download is always available — final safety net, user-gesture. */}
        <button className="sn-btn-ghost" onClick={onManualDownload} disabled={persisting}>
          <Icons.Download size={12} /> Download
        </button>

        <button className="sn-btn-ghost" onClick={onDiscard} disabled={persisting}>
          Discard
        </button>

        {isPending && (
          <button className="sn-btn-primary" onClick={onSave}>
            {tab === 'punch-in' ? 'Save & punch-in' : autoAdd ? 'Save & add to timeline' : 'Save to library'}
          </button>
        )}
        {inFallback && (
          <button className="sn-btn-primary" onClick={onRetrySave}>
            Retry save
          </button>
        )}
        {inLibrary && !addedToTimeline && (
          <button className="sn-btn-primary" onClick={onAddToTimeline}>
            {tab === 'punch-in' ? 'Apply punch-in' : 'Add to timeline'}
          </button>
        )}
        {inLibrary && addedToTimeline && (
          <button className="sn-btn-primary" disabled style={{ opacity: 0.6 }}>
            <Icons.Check size={12} /> Added
          </button>
        )}
      </div>
    </div>
  );
}

function StatusBanner({
  kind,
  children,
}: {
  kind: 'info' | 'success' | 'warn';
  children: React.ReactNode;
}) {
  const palette =
    kind === 'success'
      ? { bg: 'rgba(200, 242, 58, 0.08)', border: 'rgba(200, 242, 58, 0.35)', color: 'var(--accent-primary)' }
      : kind === 'warn'
        ? { bg: 'rgba(242, 168, 58, 0.10)', border: 'rgba(242, 168, 58, 0.40)', color: 'var(--orange, #F2A83A)' }
        : { bg: 'rgba(58, 200, 242, 0.08)', border: 'rgba(58, 200, 242, 0.35)', color: 'var(--text-primary)' };
  return (
    <div
      style={{
        padding: '8px 12px',
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 6,
        fontSize: 12,
        color: palette.color,
      }}
    >
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--text-secondary)',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      {children}
      {hint && (
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>{hint}</div>
      )}
    </div>
  );
}

function pillStyle(active: boolean): React.CSSProperties {
  return {
    padding: '7px 14px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
    background: active ? 'rgba(200,242,58,0.1)' : 'var(--bg-base)',
    color: active ? 'var(--accent-primary)' : 'var(--text-primary)',
    cursor: 'pointer',
  };
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function drawWaveform(canvas: HTMLCanvasElement | null, samples: Float32Array): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: W, height: H } = canvas;
  ctx.clearRect(0, 0, W, H);
  // Subtle grid baseline
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();

  // Waveform line
  ctx.strokeStyle = '#C8F23A';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(samples.length / W));
  for (let x = 0; x < W; x++) {
    const i = x * step;
    const v = samples[i] ?? 0;
    const y = H / 2 - v * (H / 2 - 4);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
