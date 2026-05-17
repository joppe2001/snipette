import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useEditorStore } from '@/store/editor.store';
import { useProjectStore } from '@/store/project.store';
import { useExportStore } from '@/store/export.store';
import { useTimelineStore } from '@/store/timeline.store';
import { Icons } from '@/components/ui/icons';
import { formatTime } from '@/utils/time';
import { fileSizeLabel } from '@/utils/file';
import { runWebExport, isWebExportAvailable } from '@/utils/web-export';
import type { ExportFormat, ExportOpts, ExportQuality, Format } from '@shared/types';
import type { ExportPreset } from '@/store/export.store';

const PRESETS: { id: ExportPreset; label: string; format: Format; width: number; height: number; fps: number; quality: ExportQuality; Icon: typeof Icons.Phone; note: string }[] = [
  { id: 'tiktok', label: 'TikTok', format: '9:16', width: 1080, height: 1920, fps: 30, quality: 'high', Icon: Icons.Phone, note: 'H.264 · max 287 MB' },
  { id: 'reels', label: 'Instagram Reels', format: '9:16', width: 1080, height: 1920, fps: 30, quality: 'high', Icon: Icons.Phone, note: 'H.264 · 30fps' },
  { id: 'shorts', label: 'YouTube Shorts', format: '9:16', width: 1080, height: 1920, fps: 60, quality: 'high', Icon: Icons.Phone, note: 'H.264 · 60fps recommended' },
  { id: 'instagram-feed', label: 'Instagram Feed', format: '1:1', width: 1080, height: 1080, fps: 30, quality: 'high', Icon: Icons.Square, note: '1:1 or 4:5' },
  { id: 'youtube', label: 'YouTube', format: '16:9', width: 1920, height: 1080, fps: 30, quality: 'best', Icon: Icons.Monitor, note: '16:9 high quality' },
  { id: 'custom', label: 'Custom', format: '9:16', width: 1080, height: 1920, fps: 30, quality: 'high', Icon: Icons.Settings, note: 'Tweak everything' },
];

const QUALITIES: ExportQuality[] = ['draft', 'good', 'high', 'best', 'lossless'];
const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: 'mp4', label: 'MP4 · H.264' },
  { id: 'mp4-h265', label: 'MP4 · H.265' },
  { id: 'mov', label: 'MOV' },
  { id: 'webm', label: 'WebM · VP9' },
  { id: 'gif', label: 'GIF' },
];

export function ExportModal(): JSX.Element {
  const open = useEditorStore((s) => s.exportModalOpen);
  const close = useEditorStore((s) => s.closeExport);
  const project = useProjectStore((s) => s.activeProject);
  const assets = useProjectStore((s) => s.assets);
  const tracks = useTimelineStore((s) => s.tracks);
  const clips = useTimelineStore((s) => s.clips);
  const transitions = useTimelineStore((s) => s.transitions);
  const { config, setConfig, run, setRun, reset } = useExportStore();
  const [stage, setStage] = useState<'settings' | 'progress' | 'done'>('settings');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      setStage('settings');
      reset();
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open, reset]);

  useEffect(() => {
    const offProgress = window.snipette.export.onProgress((p) => {
      setRun({ progress: p.percent, stage: p.stage, etaSeconds: p.etaSeconds });
    });
    const offComplete = window.snipette.export.onComplete((p) => {
      setRun({ status: 'done', progress: 100, outputPath: p.outputPath, fileSizeBytes: p.fileSizeBytes });
      setStage('done');
    });
    const offError = window.snipette.export.onError((p) => {
      setRun({ status: 'error', error: p.error });
    });
    return () => {
      offProgress();
      offComplete();
      offError();
    };
  }, [setRun]);

  const choosePreset = (id: ExportPreset) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setConfig({
      preset: id,
      width: preset.width,
      height: preset.height,
      fps: preset.fps,
      quality: preset.quality,
    });
  };

  const runLegacyExport = async (opts: ExportOpts, outputPath: string) => {
    const jobId = await window.snipette.export.start(opts);
    setRun({ jobId, status: 'running', progress: 0, stage: 'Starting…', error: null, outputPath });
    setStage('progress');
  };

  const runStudioExport = async (outputPath: string) => {
    if (!project) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRun({
      jobId: 'studio',
      status: 'running',
      progress: 0,
      stage: 'Starting…',
      error: null,
      outputPath,
    });
    setStage('progress');

    // Resolution scaling: the editor preview internally uses the project's NATIVE
    // resolution (1080-wide for 9:16, etc.) and only CSS-transforms it down to fit
    // the visible viewport. So font sizes, position offsets, and motion-FX values
    // are already in the right space when exporting at native resolution — we only
    // need to scale them when exporting at a DIFFERENT resolution than the project.
    // (Previously this measured the DISPLAY size via getBoundingClientRect, which
    // wrongly upscaled everything by the display-to-export ratio.)
    const previewWidth = project.width;

    try {
      const result = await runWebExport(
        {
          project,
          tracks,
          clips,
          transitions,
          assets,
          outputPath,
          width: config.width,
          height: config.height,
          fps: config.fps,
          format: config.format,
          quality: config.quality,
          includeAudio: config.includeAudio,
          targetBitrate: config.targetBitrate,
          normalizeLoudness: config.normalizeLoudness,
          previewWidth,
        },
        {
          onProgress: (p) => {
            setRun({
              progress: Math.round(p.fraction * 100),
              stage: p.stage,
              etaSeconds: p.etaSeconds,
            });
          },
          signal: controller.signal,
        },
      );
      setRun({
        status: 'done',
        progress: 100,
        outputPath: result.outputPath,
        fileSizeBytes: result.fileSizeBytes,
      });
      setStage('done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Auto-fallback: any error from the new engine that isn't a cancellation drops
      // back to the legacy FFmpeg path so the user still gets a file.
      if (controller.signal.aborted) {
        setRun({ status: 'cancelled', error: null });
        return;
      }
      // eslint-disable-next-line no-console
      console.warn('[export] studio engine failed, falling back to legacy', err);
      setRun({ status: 'running', stage: `Falling back: ${message}`, progress: 0 });
      try {
        const opts = buildLegacyOpts(outputPath);
        await runLegacyExport(opts, outputPath);
      } catch (err2) {
        const m2 = err2 instanceof Error ? err2.message : String(err2);
        setRun({ status: 'error', error: m2 });
      }
    } finally {
      abortRef.current = null;
    }
  };

  const buildLegacyOpts = (outputPath: string): ExportOpts => {
    if (!project) throw new Error('No active project');
    const baseOpts: ExportOpts = {
      project_id: project.id,
      output_path: outputPath,
      format: config.format,
      quality: config.quality,
      width: config.width,
      height: config.height,
      fps: config.fps,
      include_audio: config.includeAudio,
    };
    const advancedExtras: Record<string, unknown> = {
      two_pass: config.twoPass,
      hw_accel: config.hwAccel,
      normalize_loudness: config.normalizeLoudness,
    };
    if (config.targetBitrate && config.targetBitrate > 0) {
      advancedExtras.target_bitrate = config.targetBitrate;
    }
    if (config.profile) {
      advancedExtras.profile = config.profile;
    }
    if (config.pixelFormat) {
      advancedExtras.pixel_format = config.pixelFormat;
    }
    return { ...baseOpts, ...advancedExtras } as ExportOpts;
  };

  const startExport = async () => {
    if (!project) return;
    let outputDir = config.outputDir;
    if (!outputDir) {
      const picked = await window.snipette.system.showFilePicker({
        title: 'Choose output folder',
        directory: true,
      });
      if (!picked.length) return;
      outputDir = picked[0];
      setConfig({ outputDir });
    }
    const fileName = `${config.fileName || 'snipette-export'}.${config.format === 'gif' ? 'gif' : config.format === 'webm' ? 'webm' : config.format === 'mov' ? 'mov' : 'mp4'}`;
    const outputPath = `${outputDir}/${fileName}`;

    // Decide which engine to use. The new engine supports mp4/mov H.264 + mp4 H.265;
    // WebM/GIF fall back to the legacy FFmpeg path automatically.
    const studioSupportsFormat = config.format === 'mp4' || config.format === 'mp4-h265' || config.format === 'mov';
    const useStudio = config.useNewEngine && isWebExportAvailable() && studioSupportsFormat;

    if (useStudio) {
      await runStudioExport(outputPath);
    } else {
      await runLegacyExport(buildLegacyOpts(outputPath), outputPath);
    }
  };

  const cancelExport = async () => {
    if (abortRef.current) {
      abortRef.current.abort();
      if (project) {
        await window.snipette.webExport.cancel(project.id).catch(() => undefined);
      }
      setRun({ status: 'cancelled' });
      close();
      return;
    }
    if (run.jobId) {
      await window.snipette.export.cancel(run.jobId);
      setRun({ status: 'cancelled' });
    }
    close();
  };

  const estimatedSize = useMemo(() => {
    if (!project) return 0;
    const bitratePerS =
      config.quality === 'draft' ? 4_000_000 : config.quality === 'good' ? 8_000_000 : config.quality === 'high' ? 14_000_000 : 22_000_000;
    return (bitratePerS * (project.duration_ms / 1000)) / 8;
  }, [project, config.quality]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(10,10,12,0.85)',
            backdropFilter: 'blur(12px)',
            zIndex: 1100,
            display: 'flex',
            flexDirection: 'column',
            padding: '40px 8vw',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 32 }}>
            <span className="display" style={{ fontSize: 42, letterSpacing: '0.06em' }}>EXPORT</span>
            <div style={{ flex: 1 }} />
            <button className="sn-icon-btn" onClick={stage === 'progress' ? cancelExport : close} aria-label="Close">
              <Icons.X size={16} />
            </button>
          </div>

          {stage === 'settings' && project && (
            <SettingsStage
              project={project}
              config={config}
              setConfig={setConfig}
              choosePreset={choosePreset}
              estimatedSize={estimatedSize}
              onStart={startExport}
            />
          )}

          {stage === 'progress' && (
            <ProgressStage progress={run.progress} stageLabel={run.stage} etaSeconds={run.etaSeconds} onCancel={cancelExport} error={run.error} />
          )}

          {stage === 'done' && run.outputPath && (
            <DoneStage outputPath={run.outputPath} fileSize={run.fileSizeBytes ?? 0} onClose={close} />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SettingsStage({ project, config, setConfig, choosePreset, estimatedSize, onStart }: {
  project: import('@shared/types').Project;
  config: ReturnType<typeof useExportStore.getState>['config'];
  setConfig: (u: Partial<ReturnType<typeof useExportStore.getState>['config']>) => void;
  choosePreset: (id: ExportPreset) => void;
  estimatedSize: number;
  onStart: () => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 32, flex: 1, minHeight: 0 }}>
      <div style={{ overflow: 'auto' }}>
        <SectionLabel>Platform preset</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 28 }}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => choosePreset(p.id)}
              style={{
                padding: 16,
                borderRadius: 12,
                border: `1.5px solid ${config.preset === p.id ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                background: config.preset === p.id ? 'rgba(200,242,58,0.06)' : 'var(--bg-surface)',
                textAlign: 'left',
              }}
            >
              <p.Icon size={28} stroke={config.preset === p.id ? 'var(--accent-primary)' : 'var(--text-secondary)'} />
              <div style={{ fontSize: 13, fontWeight: 700, marginTop: 8 }}>{p.label}</div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>{p.format} · {p.width}×{p.height}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{p.note}</div>
            </button>
          ))}
        </div>

        <SectionLabel>Quality</SectionLabel>
        <div style={{ display: 'flex', gap: 6, marginBottom: 24 }}>
          {QUALITIES.map((q) => (
            <button
              key={q}
              onClick={() => setConfig({ quality: q })}
              style={{
                padding: '7px 14px',
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                border: `1px solid ${config.quality === q ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                background: config.quality === q ? 'rgba(200,242,58,0.1)' : 'var(--bg-base)',
                color: config.quality === q ? 'var(--accent-primary)' : 'var(--text-primary)',
                textTransform: 'capitalize',
              }}
            >
              {q}
            </button>
          ))}
        </div>

        <SectionLabel>Format</SectionLabel>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 24 }}>
          {FORMATS.map((f) => (
            <button
              key={f.id}
              onClick={() => setConfig({ format: f.id })}
              style={{
                padding: '7px 12px',
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 600,
                border: `1px solid ${config.format === f.id ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                background: config.format === f.id ? 'rgba(200,242,58,0.1)' : 'var(--bg-base)',
                color: config.format === f.id ? 'var(--accent-primary)' : 'var(--text-primary)',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        <SectionLabel>Audio</SectionLabel>
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          <button
            onClick={() => setConfig({ includeAudio: true })}
            style={pillStyle(config.includeAudio)}
          >Include audio</button>
          <button
            onClick={() => setConfig({ includeAudio: false })}
            style={pillStyle(!config.includeAudio)}
          >Mute</button>
        </div>

        <AdvancedSection config={config} setConfig={setConfig} />

        <SectionLabel>Output</SectionLabel>
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          <input
            value={config.fileName}
            onChange={(e) => setConfig({ fileName: e.target.value })}
            placeholder="snipette-export"
            style={{
              background: 'var(--bg-base)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 12,
              flex: 1,
              color: 'var(--text-primary)',
            }}
          />
          <button
            className="sn-btn-ghost"
            onClick={async () => {
              const picked = await window.snipette.system.showFilePicker({ title: 'Output folder', directory: true });
              if (picked.length) setConfig({ outputDir: picked[0] });
            }}
          >
            <Icons.Folder size={12} /> {config.outputDir ? 'Change folder…' : 'Choose folder…'}
          </button>
        </div>
        {config.outputDir && (
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 24 }}>
            → {config.outputDir}
          </div>
        )}
      </div>

      <div>
        <div style={{ background: 'var(--bg-surface)', borderRadius: 16, padding: 24, border: '1px solid var(--border-subtle)' }}>
          <SectionLabel>Your export at a glance</SectionLabel>
          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 12 }}>
            <Stat label="Resolution" value={`${config.width}×${config.height}`} />
            <Stat label="FPS" value={`${config.fps}`} />
            <Stat label="Duration" value={formatTime(project.duration_ms, true)} />
            <Stat label="Estimated size" value={fileSizeLabel(estimatedSize)} />
          </div>
          <div style={{ marginTop: 18, padding: 12, background: 'var(--bg-base)', borderRadius: 8, fontSize: 11, color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icons.Lock size={12} /> Exported locally — never uploaded
          </div>
          <button
            className="sn-btn-primary"
            style={{ width: '100%', justifyContent: 'center', marginTop: 18, padding: '12px 14px', fontSize: 13 }}
            onClick={onStart}
          >
            Export now → <Icons.Arrow size={13} stroke="#0A0A0C" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ProgressStage({ progress, stageLabel, etaSeconds, onCancel, error }: {
  progress: number;
  stageLabel: string;
  etaSeconds: number;
  onCancel: () => void;
  error: string | null;
}) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
      <ProgressRing percent={progress} />
      <div style={{ textAlign: 'center' }}>
        <div className="display" style={{ fontSize: 22, letterSpacing: '0.06em' }}>{stageLabel || 'Encoding'}</div>
        <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
          {etaSeconds > 0 ? `${Math.round(etaSeconds)}s remaining` : '—'}
        </div>
      </div>
      {error && <div style={{ color: 'var(--red-alert)', fontSize: 12 }}>{error}</div>}
      <button className="sn-btn-ghost" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function DoneStage({ outputPath, fileSize, onClose }: { outputPath: string; fileSize: number; onClose: () => void }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
      <ProgressRing percent={100} done />
      <div className="display" style={{ fontSize: 32, color: 'var(--accent-primary)' }}>EXPORT COMPLETE</div>
      <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{outputPath}</div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fileSizeLabel(fileSize)}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="sn-btn-ghost" onClick={() => window.snipette.system.openInFinder(outputPath)}>
          <Icons.Folder size={12} /> Reveal file
        </button>
        <button className="sn-btn-primary" onClick={onClose}>Back to editor</button>
      </div>
    </div>
  );
}

function ProgressRing({ percent, done }: { percent: number; done?: boolean }) {
  const radius = 92;
  const stroke = 8;
  const norm = radius - stroke / 2;
  const circ = 2 * Math.PI * norm;
  const dash = (Math.min(100, Math.max(0, percent)) / 100) * circ;
  return (
    <div style={{ position: 'relative', width: 220, height: 220 }}>
      <svg width={220} height={220}>
        <circle cx={110} cy={110} r={norm} stroke="rgba(255,255,255,0.06)" strokeWidth={stroke} fill="none" />
        <circle
          cx={110}
          cy={110}
          r={norm}
          stroke="var(--accent-primary)"
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ - dash}`}
          transform="rotate(-90 110 110)"
          style={{ filter: 'drop-shadow(0 0 12px rgba(200,242,58,0.5))', transition: 'stroke-dasharray .3s' }}
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          fontFamily: 'var(--font-mono)',
          fontSize: 42,
          color: 'var(--accent-primary)',
        }}
      >
        {done ? <Icons.Check size={64} stroke="var(--accent-primary)" sw={3} /> : `${Math.round(percent)}%`}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="sn-section-label" style={{ marginBottom: 10 }}>{children}</div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 9.5, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>
        {label}
      </div>
      <div className="mono" style={{ marginTop: 2 }}>{value}</div>
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
  };
}

type AdvancedConfig = ReturnType<typeof useExportStore.getState>['config'];

function AdvancedSection({
  config,
  setConfig,
}: {
  config: AdvancedConfig;
  setConfig: (u: Partial<AdvancedConfig>) => void;
}) {
  const [open, setOpen] = useState(false);
  const isH264 = config.format === 'mp4' || config.format === 'mov';
  const isHevc = config.format === 'mp4-h265';
  const allowsPixelFormat = isH264 || isHevc;
  const bitrateMbps = config.targetBitrate ? config.targetBitrate / 1_000_000 : '';

  return (
    <div style={{ marginBottom: 24 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '8px 0',
          background: 'transparent',
          border: 'none',
          color: 'var(--text-primary)',
          cursor: 'pointer',
        }}
        aria-expanded={open}
      >
        <Icons.Settings size={12} stroke="var(--text-secondary)" />
        <span className="sn-section-label" style={{ margin: 0 }}>
          Advanced
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 10,
            color: 'var(--text-muted)',
            transition: 'transform .15s',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
          aria-hidden
        >
          {'>'}
        </span>
      </button>
      {open && (
        <div
          style={{
            marginTop: 12,
            padding: 16,
            borderRadius: 10,
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-base)',
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          <div>
            <SectionLabel>Export engine</SectionLabel>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button
                onClick={() => setConfig({ useNewEngine: true })}
                style={pillStyle(config.useNewEngine)}
              >
                Studio (canvas)
              </button>
              <button
                onClick={() => setConfig({ useNewEngine: false })}
                style={pillStyle(!config.useNewEngine)}
              >
                Legacy (FFmpeg)
              </button>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>
              Studio renders the timeline frame-by-frame using the same code as the live preview, so custom fonts, emoji, gradients, glow, and per-character animations match what you see while editing. Legacy runs the existing FFmpeg filter graph — pick it for WebM/GIF or if Studio misbehaves.
            </div>
          </div>

          <div>
            <SectionLabel>Hardware acceleration</SectionLabel>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button onClick={() => setConfig({ hwAccel: 'auto' })} style={pillStyle(config.hwAccel === 'auto')}>
                Auto
              </button>
              <button onClick={() => setConfig({ hwAccel: 'none' })} style={pillStyle(config.hwAccel === 'none')}>
                Off
              </button>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>
              Auto uses VideoToolbox on macOS, NVENC/QSV on Windows, VA-API on Linux when available.
            </div>
          </div>

          <div>
            <SectionLabel>2-pass encoding</SectionLabel>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button onClick={() => setConfig({ twoPass: false })} style={pillStyle(!config.twoPass)}>
                Off
              </button>
              <button onClick={() => setConfig({ twoPass: true })} style={pillStyle(config.twoPass)}>
                On
              </button>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>
              Smaller files at the same quality. Roughly 2x longer encode. Software encoders only.
            </div>
          </div>

          <div>
            <SectionLabel>Target bitrate</SectionLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <input
                type="number"
                min={0}
                step={0.5}
                value={bitrateMbps}
                onChange={(e) => {
                  const val = e.target.value.trim();
                  if (val === '') {
                    setConfig({ targetBitrate: undefined });
                  } else {
                    const mbps = parseFloat(val);
                    if (!Number.isFinite(mbps) || mbps <= 0) {
                      setConfig({ targetBitrate: undefined });
                    } else {
                      setConfig({ targetBitrate: Math.round(mbps * 1_000_000) });
                    }
                  }
                }}
                placeholder="auto"
                style={{
                  width: 110,
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 6,
                  padding: '7px 10px',
                  fontSize: 12,
                  color: 'var(--text-primary)',
                }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Mbps</span>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>
              Blank = use quality preset. Hardware encoders always use bitrate control.
            </div>
          </div>

          <div>
            <SectionLabel>Normalize loudness</SectionLabel>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button
                onClick={() => setConfig({ normalizeLoudness: false })}
                style={pillStyle(!config.normalizeLoudness)}
              >
                Off
              </button>
              <button
                onClick={() => setConfig({ normalizeLoudness: true })}
                style={pillStyle(config.normalizeLoudness)}
              >
                On
              </button>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>
              EBU R128 (-16 LUFS) — recommended for upload to TikTok/Instagram.
            </div>
          </div>

          {isH264 && (
            <div>
              <SectionLabel>Profile</SectionLabel>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                {(['baseline', 'main', 'high'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() =>
                      setConfig({ profile: config.profile === p ? undefined : p })
                    }
                    style={pillStyle(config.profile === p)}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>
                High = best compression; Baseline = widest device support.
              </div>
            </div>
          )}

          {allowsPixelFormat && (
            <div>
              <SectionLabel>Pixel format</SectionLabel>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button
                  onClick={() =>
                    setConfig({
                      pixelFormat: config.pixelFormat === 'yuv420p' ? undefined : 'yuv420p',
                    })
                  }
                  style={pillStyle(config.pixelFormat === 'yuv420p' || !config.pixelFormat)}
                >
                  8-bit (yuv420p)
                </button>
                <button
                  onClick={() => setConfig({ pixelFormat: 'yuv420p10le' })}
                  style={pillStyle(config.pixelFormat === 'yuv420p10le')}
                >
                  10-bit (yuv420p10le)
                </button>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>
                10-bit reduces banding on gradients; check device compatibility before sharing.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
