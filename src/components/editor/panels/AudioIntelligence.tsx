import { useState } from 'react';
import type { Clip } from '@shared/types';
import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import { Field, FieldRow } from '../RightPanel';
import { Slider } from '@/components/ui/Slider';
import { Toggle } from '@/components/ui/Toggle';
import {
  detectSilence,
  detectVoiceActivity,
  type SilenceRegion,
  type DuckSegment,
} from '@/utils/audio-analysis';
import { parseEffectsArray, type RawEffectEntry } from '@/utils/audio-fx';
import { parseKeyframes, writeKeyframes, type Keyframe } from '@/utils/keyframes';
import { makeMarker, MARKER_COLORS } from '@/utils/markers';
import { computeAutoZoomKeyframes, toKeyframes } from '@/utils/auto-zoom';
import { beatsSourceToTimeline, computeBeatCutPlan } from '@/utils/auto-cut-beats';

/**
 * Module-scoped waveform fetch dedupe. The panel's event handlers (Preview detection,
 * Detect voice, Apply auto zoom) each kick off `window.snipette.media.waveform(assetId)`
 * directly. Without dedupe, double-clicking "Detect voice" or rapidly toggling between
 * sections fires N concurrent IPC fetches for the same asset — each round-trips the full
 * waveform from disk. This map tracks the in-flight Promise per assetId; subsequent calls
 * await the same Promise and the result is also cached so repeats inside one session
 * skip the IPC entirely.
 *
 * Coordinated with `useWaveform`'s own module-level cache: this layer dedupes the
 * imperative call path; the hook covers the declarative read path. Both end up calling
 * the same IPC underneath, so the user never pays for the same waveform twice.
 */
const inFlightWaveforms = new Map<string, Promise<number[]>>();
const waveformResultCache = new Map<string, number[]>();

async function fetchWaveformDeduped(assetId: string): Promise<number[]> {
  const cached = waveformResultCache.get(assetId);
  if (cached) return cached;
  const existing = inFlightWaveforms.get(assetId);
  if (existing) return existing;
  const p = window.snipette.media
    .waveform(assetId)
    .then((d) => {
      waveformResultCache.set(assetId, d);
      inFlightWaveforms.delete(assetId);
      return d;
    })
    .catch((err) => {
      inFlightWaveforms.delete(assetId);
      throw err;
    });
  inFlightWaveforms.set(assetId, p);
  return p;
}

interface Props {
  clip: Clip;
}

interface SilencePreview {
  count: number;
  totalMs: number;
  regions: SilenceRegion[];
}

/**
 * Three-section panel that wraps the audio-intelligence features:
 *   1. Auto-cut on silence (waveform-driven splits/deletes on this clip).
 *   2. Auto-duck (detect voice activity, lower volume on overlapping music clips).
 *   3. Loudness normalization toggle (stored on effects_json, baked at export time).
 *
 * The detection itself happens in-browser via `window.snipette.media.waveform`; the
 * timeline mutations route through the same IPC + store actions the inspector already
 * uses, so undo/redo and the SQLite mirror stay consistent.
 */
export function AudioIntelligence({ clip }: Props): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <AutoCutSection clip={clip} />
      <AutoDuckSection clip={clip} />
      <AutoPunchInZoomSection clip={clip} />
      <LoudnessSection clip={clip} />
      <BeatDetectionSection clip={clip} />
      <BeatSyncAutoCutSection clip={clip} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared layout primitives                                            */
/* ------------------------------------------------------------------ */

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      style={{
        background: 'var(--bg-base)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 6,
        padding: 10,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.4 }}>
        {description}
      </div>
      {children}
    </div>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        padding: '7px 10px',
        background: disabled ? 'var(--bg-elev-1)' : 'var(--accent-primary)',
        color: disabled ? 'var(--text-muted)' : '#0A0A0C',
        border: 'none',
        borderRadius: 6,
        fontSize: 11.5,
        fontWeight: 600,
        cursor: disabled ? 'default' : 'pointer',
        marginTop: 6,
      }}
    >
      {children}
    </button>
  );
}

function GhostButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      className="sn-btn-ghost"
      onClick={onClick}
      disabled={disabled}
      style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Section 1 — Auto-cut on silence                                     */
/* ------------------------------------------------------------------ */

function AutoCutSection({ clip }: Props): JSX.Element {
  const pushToast = useEditorStore((s) => s.pushToast);
  const [threshold, setThreshold] = useState<number>(0.04);
  const [minMs, setMinMs] = useState<number>(400);
  const [preview, setPreview] = useState<SilencePreview | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const fetchWaveform = async (): Promise<number[] | null> => {
    if (!clip.asset_id) return null;
    try {
      return await fetchWaveformDeduped(clip.asset_id);
    } catch {
      return null;
    }
  };

  const runPreview = async (): Promise<void> => {
    const wave = await fetchWaveform();
    if (!wave || wave.length === 0) {
      pushToast({ kind: 'error', message: 'No waveform available for this clip.' });
      setPreview(null);
      return;
    }
    const assetTotalMs = clip.source_out_ms - clip.source_in_ms;
    const inRatio = clip.source_in_ms / Math.max(1, clip.source_out_ms);
    const outRatio = clip.source_out_ms / Math.max(1, clip.source_out_ms);
    // The waveform spans the WHOLE asset. Trim to just the clip's source window so the
    // detection only considers samples the user actually sees.
    const startIdx = Math.max(0, Math.floor(inRatio * wave.length));
    const endIdx = Math.max(startIdx + 1, Math.floor(outRatio * wave.length));
    const subWave = wave.slice(startIdx, endIdx);

    const regions = detectSilence(subWave, assetTotalMs, {
      threshold,
      minDurationMs: minMs,
    }).map((r) => ({
      // Shift back to source-time on the asset (add source_in_ms).
      startMs: r.startMs + clip.source_in_ms,
      endMs: r.endMs + clip.source_in_ms,
    }));

    const totalMs = regions.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
    setPreview({ count: regions.length, totalMs, regions });
  };

  /**
   * Apply auto-cut: convert each source-time silence region into a timeline-time region,
   * sort left→right, then split-and-delete iteratively. After every delete we shift later
   * timeline times left by the removed duration so the next region lines up with reality.
   *
   * Heuristic: each silence region is expected to fall inside a single descendant of the
   * original clip after prior splits. If we can't find such a clip (e.g. a previous step
   * already consumed it), we bail on that region and keep going — the user gets a partial
   * result rather than a broken timeline.
   */
  const applyAutoCut = async (): Promise<void> => {
    if (!preview || preview.regions.length === 0) return;
    setBusy(true);
    const store = useTimelineStore.getState();
    store.pushHistory();

    // Convert source-time regions to timeline-time regions on the ORIGINAL clip.
    const speed = Math.max(0.05, clip.speed);
    const trackId = clip.track_id;
    const timelineRegions = preview.regions
      .map((r) => ({
        startMs: clip.start_time_ms + (r.startMs - clip.source_in_ms) / speed,
        endMs: clip.start_time_ms + (r.endMs - clip.source_in_ms) / speed,
      }))
      .sort((a, b) => a.startMs - b.startMs);

    let removedTotal = 0;
    let failures = 0;

    try {
      for (const region of timelineRegions) {
        const startT = region.startMs - removedTotal;
        const endT = region.endMs - removedTotal;
        if (endT - startT <= 1) continue;

        const live = useTimelineStore.getState().clips;
        // Find a descendant clip on the same track that fully covers [startT, endT].
        const current = live.find(
          (c) =>
            c.track_id === trackId &&
            c.start_time_ms <= startT + 0.5 &&
            c.start_time_ms + c.duration_ms >= endT - 0.5,
        );
        if (!current) {
          failures += 1;
          continue;
        }

        try {
          // 1) Split at startT — yields [left, after1]; the silent chunk sits in after1.
          const [leftHalf, afterStart] = await window.snipette.timeline.splitClip(
            current.id,
            startT,
          );
          useTimelineStore.getState().replaceClip(leftHalf);
          useTimelineStore.getState().addClip(afterStart);

          // 2) Split afterStart at endT — yields [silent, tail].
          const [silent, tail] = await window.snipette.timeline.splitClip(afterStart.id, endT);
          useTimelineStore.getState().replaceClip(silent);
          useTimelineStore.getState().addClip(tail);

          // 3) Delete the silent middle piece.
          await window.snipette.timeline.deleteClip(silent.id);
          useTimelineStore.getState().removeClip(silent.id);

          const removed = endT - startT;

          // 4) Ripple: shift the tail and any later clips on this track left by `removed`.
          const afterRipple = useTimelineStore.getState().clips;
          for (const c of afterRipple) {
            if (c.track_id !== trackId) continue;
            if (c.start_time_ms >= endT - 0.5 && c.id !== silent.id) {
              const next = { ...c, start_time_ms: c.start_time_ms - removed };
              try {
                const updated = await window.snipette.timeline.updateClip(c.id, {
                  start_time_ms: next.start_time_ms,
                });
                useTimelineStore.getState().replaceClip(updated);
              } catch {
                // If the IPC update fails, at least keep the in-memory store coherent so the
                // next iteration's region math is consistent.
                useTimelineStore.getState().replaceClip(next);
              }
            }
          }

          removedTotal += removed;
        } catch {
          failures += 1;
          continue;
        }
      }

      useTimelineStore.getState().computeDuration();
      const ok = timelineRegions.length - failures;
      if (ok > 0) {
        pushToast({
          kind: 'success',
          message: `Auto-cut: removed ${ok} silent region${ok === 1 ? '' : 's'}.`,
        });
      } else {
        pushToast({ kind: 'error', message: 'Auto-cut could not apply to this clip.' });
      }
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      title="Auto-cut on silence"
      description="Trim silent gaps from this clip. Splits the clip into pieces, keeping only the loud parts."
    >
      <FieldRow>
        <Field label={`Threshold · ${threshold.toFixed(3)}`}>
          <Slider
            value={threshold}
            min={0}
            max={0.3}
            onChange={setThreshold}
            onCommit={setThreshold}
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label={`Min silence · ${Math.round(minMs)} ms`}>
          <Slider
            value={minMs}
            min={100}
            max={2000}
            step={10}
            onChange={setMinMs}
            onCommit={setMinMs}
          />
        </Field>
      </FieldRow>

      <GhostButton onClick={() => void runPreview()} disabled={busy}>
        Preview detection
      </GhostButton>
      {preview ? (
        <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 6 }}>
          Found {preview.count} silent region{preview.count === 1 ? '' : 's'} totaling{' '}
          {(preview.totalMs / 1000).toFixed(2)}s
        </div>
      ) : null}

      <PrimaryButton
        onClick={() => void applyAutoCut()}
        disabled={busy || !preview || preview.count === 0}
      >
        {busy ? 'Applying…' : 'Apply auto-cut'}
      </PrimaryButton>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Section 2 — Auto-duck                                               */
/* ------------------------------------------------------------------ */

type SensitivityPreset = 'whispers' | 'speech' | 'shouts';

interface SensitivitySpec {
  threshold: number;
  minDurationMs: number;
}

// Trick: pair a LOW threshold with a LONG minimum duration. A low threshold catches
// the soft onset of speech (the first 1–2 s where you're ramping into a word stays
// below higher thresholds), while the long minimum filters out short bursts like
// breaths and lip smacks (typically 200–500 ms). Loud-only inverts the trade:
// higher threshold, shorter min, only fires on sustained shouting.
const SENSITIVITY_SPECS: Record<SensitivityPreset, SensitivitySpec> = {
  whispers: { threshold: 0.03, minDurationMs: 300 },
  speech: { threshold: 0.05, minDurationMs: 600 },
  shouts: { threshold: 0.10, minDurationMs: 400 },
};

function AutoDuckSection({ clip }: Props): JSX.Element {
  const pushToast = useEditorStore((s) => s.pushToast);
  const [duckedVolume, setDuckedVolume] = useState<number>(0.3);
  // Preset rather than raw threshold — labels tell the user exactly what each does.
  const [sensitivity, setSensitivity] = useState<SensitivityPreset>('speech');
  const [busy, setBusy] = useState<boolean>(false);

  const runDuck = async (): Promise<void> => {
    if (!clip.asset_id) {
      pushToast({ kind: 'error', message: 'No audio source on this clip.' });
      return;
    }
    setBusy(true);
    try {
      const wave = await fetchWaveformDeduped(clip.asset_id);
      if (!wave || wave.length === 0) {
        pushToast({ kind: 'error', message: 'No waveform available.' });
        return;
      }

      // Trim waveform to the clip's source window before detecting voice activity.
      const startIdx = Math.max(
        0,
        Math.floor((clip.source_in_ms / Math.max(1, clip.source_out_ms)) * wave.length),
      );
      const endIdx = Math.max(
        startIdx + 1,
        Math.floor((clip.source_out_ms / Math.max(1, clip.source_out_ms)) * wave.length),
      );
      const subWave = wave.slice(startIdx, endIdx);

      const rawVoice: DuckSegment[] = detectVoiceActivity(
        subWave,
        clip.start_time_ms,
        clip.duration_ms,
        SENSITIVITY_SPECS[sensitivity],
      );

      // Pad each detected segment outward in TIMELINE-time. Threshold-based detection
      // misses the soft onset of speech (the first 200–400ms ramp into a word never
      // crosses the threshold), so the first words leak over un-ducked music. Padding
      // the START by 350ms catches that onset; padding the END by 150ms keeps the
      // duck a beat past the last syllable's tail.
      const PAD_START_MS = 350;
      const PAD_END_MS = 150;
      const clipEndTimelineMs = clip.start_time_ms + clip.duration_ms;
      const padded: DuckSegment[] = rawVoice.map((s) => ({
        startMs: Math.max(clip.start_time_ms, s.startMs - PAD_START_MS),
        endMs: Math.min(clipEndTimelineMs, s.endMs + PAD_END_MS),
      }));

      // Merge windows separated by short pauses (< 350 ms) — between syllables and
      // words. Without merging, the music pumps up-and-down during a single sentence.
      const MERGE_GAP_MS = 350;
      const voice: DuckSegment[] = [];
      for (const seg of padded) {
        const last = voice[voice.length - 1];
        if (last && seg.startMs - last.endMs <= MERGE_GAP_MS) {
          last.endMs = Math.max(last.endMs, seg.endMs);
        } else {
          voice.push({ ...seg });
        }
      }

      if (voice.length === 0) {
        pushToast({ kind: 'info', message: 'No voice activity detected.' });
        return;
      }

      const store = useTimelineStore.getState();
      store.pushHistory();
      const allClips = store.clips;
      const allTracks = store.tracks;

      // Music = audio tracks other than the voice clip's track.
      const musicTrackIds = new Set(
        allTracks.filter((t) => t.type === 'audio' && t.id !== clip.track_id).map((t) => t.id),
      );
      const overlapping = allClips.filter((c) => {
        if (!musicTrackIds.has(c.track_id)) return false;
        const cStart = c.start_time_ms;
        const cEnd = c.start_time_ms + c.duration_ms;
        return voice.some((v) => v.endMs > cStart && v.startMs < cEnd);
      });

      if (overlapping.length === 0) {
        pushToast({ kind: 'info', message: 'No music clips overlap the voice region.' });
        return;
      }

      // Stamp the voice clip with the detected windows in CLIP-RELATIVE time (ms from
      // the voice clip's start_time_ms). Live ducking translates them to timeline-time
      // at every preview tick using the voice clip's current position — so moving or
      // trimming the voice automatically moves the duck. Export does the same.
      const voiceEffects = parseEffectsArray(clip.effects_json);
      const duckSourceEntry: RawEffectEntry = {
        type: 'audio-duck-source',
        params: {
          ducked_volume: duckedVolume,
          window_count: voice.length,
          windows: voice.map((v) => ({
            relStartMs: v.startMs - clip.start_time_ms,
            relEndMs: v.endMs - clip.start_time_ms,
          })),
        } as unknown as Record<string, number>,
      };
      const nextVoiceEffects: RawEffectEntry[] = [
        ...voiceEffects.filter((e) => e.type !== 'audio-duck-source'),
        duckSourceEntry,
      ];
      try {
        const updatedVoice = await window.snipette.timeline.updateClip(clip.id, {
          effects_json: JSON.stringify(nextVoiceEffects),
        });
        useTimelineStore.getState().replaceClip(updatedVoice);
      } catch {
        // Non-fatal — the duck-target flag below still gets stamped on music clips.
      }

      // Flag each overlapping music clip as a duck-TARGET (no baked keyframes). The
      // preview's live duck-multiplier (utils/auto-duck.ts) reads this flag and looks
      // up voice windows from voice clips' current positions on every playhead tick.
      let applied = 0;
      for (const m of overlapping) {
        // Strip any previously-baked volume keyframes from the old approach so the
        // live duck level isn't stacked on top of stale baked ones.
        const existingKfs = parseKeyframes(m.effects_json);
        const { volume: _staleVolumeKfs, ...preservedTracks } = existingKfs;
        const withCleanedKfs = writeKeyframes(m.effects_json, preservedTracks);

        // Refresh the audio-duck-target flag with the current ducked_volume.
        let merged: RawEffectEntry[];
        try {
          const parsed = JSON.parse(withCleanedKfs) as unknown;
          merged = (Array.isArray(parsed) ? parsed : []) as RawEffectEntry[];
        } catch {
          merged = [];
        }
        merged = [
          ...merged.filter((e) => e.type !== 'audio-duck-target'),
          { type: 'audio-duck-target', params: { ducked_volume: duckedVolume } },
        ];

        try {
          const updated = await window.snipette.timeline.updateClip(m.id, {
            effects_json: JSON.stringify(merged),
          });
          useTimelineStore.getState().replaceClip(updated);
          applied += 1;
        } catch {
          // Skip and keep going on individual failures.
        }
      }

      pushToast({
        kind: 'success',
        message: `Ducked ${applied} music clip${applied === 1 ? '' : 's'} (${voice.length} voice region${
          voice.length === 1 ? '' : 's'
        }).`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      title="Auto-duck"
      description="Lower music tracks when this voice clip plays."
    >
      <FieldRow>
        <Field label={`Ducked volume · ${(duckedVolume * 100).toFixed(0)}%`}>
          <Slider
            value={duckedVolume}
            min={0}
            max={1}
            onChange={setDuckedVolume}
            onCommit={setDuckedVolume}
          />
        </Field>
      </FieldRow>

      <FieldRow>
        <Field label="Trigger on">
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            {([
              { key: 'whispers', label: 'Whispers', hint: 'Anything audible — even breaths' },
              { key: 'speech', label: 'Speech', hint: 'Normal talking, ignores breaths' },
              { key: 'shouts', label: 'Loud only', hint: 'Only emphasized / loud delivery' },
            ] as { key: SensitivityPreset; label: string; hint: string }[]).map((opt) => (
              <button
                key={opt.key}
                type="button"
                title={opt.hint}
                onClick={() => setSensitivity(opt.key)}
                style={{
                  flex: 1,
                  padding: '6px 8px',
                  fontSize: 11,
                  borderRadius: 6,
                  border: '1px solid var(--border-subtle)',
                  background:
                    sensitivity === opt.key ? 'var(--accent-primary)' : 'var(--bg-elevated)',
                  color: sensitivity === opt.key ? '#0A0A0C' : 'var(--text-primary)',
                  cursor: 'pointer',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Field>
      </FieldRow>

      <PrimaryButton onClick={() => void runDuck()} disabled={busy}>
        {busy ? 'Detecting…' : 'Detect voice + apply ducking'}
      </PrimaryButton>

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
        Music dips with a 300 ms fade-in / 600 ms fade-out and settles 150 ms before the
        voice (predictive duck). Voice
        regions within 350 ms merge so the music doesn’t pump between syllables. Hover
        the trigger options for hints. Undo to redo.
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Section 3 — Loudness normalization                                  */
/* ------------------------------------------------------------------ */

function LoudnessSection({ clip }: Props): JSX.Element {
  const pushToast = useEditorStore((s) => s.pushToast);
  const entries = parseEffectsArray(clip.effects_json);
  const enabled = entries.some((e) => e.type === 'audio-normalize');

  const toggle = async (on: boolean): Promise<void> => {
    useTimelineStore.getState().pushHistory();
    const next: RawEffectEntry[] = entries.filter((e) => e.type !== 'audio-normalize');
    if (on) next.push({ type: 'audio-normalize' });
    try {
      const updated = await window.snipette.timeline.updateClip(clip.id, {
        effects_json: JSON.stringify(next),
      });
      useTimelineStore.getState().replaceClip(updated);
    } catch {
      pushToast({ kind: 'error', message: 'Failed to update loudness setting.' });
    }
  };

  return (
    <SectionCard
      title="Loudness normalization"
      description="Match this clip to broadcast loudness (EBU R128, -16 LUFS) when exporting."
    >
      <FieldRow>
        <Field label="Normalize on export">
          <div style={{ marginTop: 2 }}>
            <Toggle on={enabled} onChange={(on) => void toggle(on)} ariaLabel="Normalize on export" />
          </div>
        </Field>
      </FieldRow>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
        Boosts quiet vocals; safer than fixed gain.
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Section 4 — Beat detection                                          */
/* ------------------------------------------------------------------ */

/** Orange beat-marker color; visually distinct from the default lime markers. */
const BEAT_MARKER_COLOR: string = MARKER_COLORS[3] ?? '#F2A83A';

/** Preset density buttons — each maps to a min-gap-between-beats in milliseconds. */
const BEAT_DENSITY_PRESETS: { id: string; label: string; minGapMs: number; hint: string }[] = [
  { id: 'all', label: 'Every beat', minGapMs: 250, hint: 'Roughly every kick + snare — busy.' },
  { id: 'strong', label: 'Strong beats', minGapMs: 500, hint: 'About one per half-second — most kicks.' },
  { id: 'downbeat', label: 'Downbeats', minGapMs: 1000, hint: 'About one per second — typical CapCut feel.' },
  { id: 'bars', label: 'Bars', minGapMs: 2000, hint: 'Once every two seconds — bar starts only.' },
  { id: 'phrases', label: 'Phrases', minGapMs: 4000, hint: 'Once every ~4 seconds — section markers.' },
];

function BeatDetectionSection({ clip }: Props): JSX.Element {
  const pushToast = useEditorStore((s) => s.pushToast);
  // Higher = pickier. Only frames that exceed local-average energy by this factor are
  // considered beat candidates. Was previously not even sent to the IPC — silently a
  // no-op slider for months. Now it actually affects the result.
  const [threshold, setThreshold] = useState<number>(1.5);
  // How far apart accepted beats must be. Within each window the algorithm keeps the
  // STRONGEST candidate, so this is what turns "every transient" into "downbeats".
  const [minGapMs, setMinGapMs] = useState<number>(1000);
  const [busy, setBusy] = useState<boolean>(false);
  // Beats are stored in SOURCE time (ms relative to the asset), trimmed to the clip's
  // source window. We translate to timeline time only when stamping markers.
  const [beats, setBeats] = useState<number[] | null>(null);

  const detectAndPreview = async (): Promise<void> => {
    if (!clip.asset_id) {
      pushToast({ kind: 'error', message: 'No audio source on this clip.' });
      return;
    }
    setBusy(true);
    try {
      const ts = await window.snipette.media.detectBeats(clip.asset_id, {
        threshold,
        minIntervalMs: minGapMs,
      });
      const inRange = ts.filter((t) => t >= clip.source_in_ms && t <= clip.source_out_ms);
      setBeats(inRange);
      pushToast({ kind: 'success', message: `Found ${inRange.length} beats.` });
    } catch (e) {
      pushToast({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Beat detection failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  const addBeatsAsMarkers = (): void => {
    if (!beats || beats.length === 0) return;
    const store = useTimelineStore.getState();
    store.pushHistory();
    const speed = Math.max(0.05, clip.speed);
    for (const sourceMs of beats) {
      // Source-time → timeline-time. Mirrors the math in AutoCutSection.applyAutoCut.
      const timelineMs = clip.start_time_ms + (sourceMs - clip.source_in_ms) / speed;
      store.addMarker(makeMarker(timelineMs, '', BEAT_MARKER_COLOR));
    }
    pushToast({ kind: 'success', message: `Added ${beats.length} markers.` });
  };

  // Average tempo across the detected range. Two beats give one interval; using span /
  // (n - 1) is more stable than the naive mean of inter-beat gaps when the threshold
  // misses occasional weak beats.
  const avgBpm =
    beats && beats.length > 1
      ? Math.round(60_000 / ((beats[beats.length - 1] - beats[0]) / (beats.length - 1)))
      : 0;

  const activePreset = BEAT_DENSITY_PRESETS.find((p) => p.minGapMs === minGapMs);

  return (
    <SectionCard
      title="Beat detection"
      description="Find beats in this clip's audio and drop a marker on the timeline at each one. Great for snapping cuts to music."
    >
      {/* Density preset chips — set the min gap between detected beats. */}
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-secondary)', marginBottom: 6 }}>
        Density
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, marginBottom: 8 }}>
        {BEAT_DENSITY_PRESETS.map((p) => {
          const active = minGapMs === p.minGapMs;
          return (
            <button
              key={p.id}
              onClick={() => setMinGapMs(p.minGapMs)}
              title={p.hint}
              style={{
                padding: '6px 6px',
                borderRadius: 5,
                fontSize: 10.5,
                fontWeight: 600,
                border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                background: active ? 'rgba(200,242,58,0.10)' : 'var(--bg-base)',
                color: active ? 'var(--accent-primary)' : 'var(--text-primary)',
                cursor: 'pointer',
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.4 }}>
        {activePreset
          ? activePreset.hint
          : `Custom: at most one beat every ${(minGapMs / 1000).toFixed(2)}s.`}
      </div>

      <FieldRow>
        <Field label={`Sensitivity · ${threshold.toFixed(2)}× (higher = pickier)`}>
          <Slider
            value={threshold}
            min={1.05}
            max={2.5}
            onChange={setThreshold}
            onCommit={setThreshold}
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field
          label={
            minGapMs < 1000
              ? `Min gap · ${minGapMs} ms`
              : `Min gap · ${(minGapMs / 1000).toFixed(2)}s`
          }
        >
          <Slider
            value={minGapMs}
            min={120}
            max={6000}
            step={20}
            onChange={(v) => setMinGapMs(Math.round(v))}
            onCommit={(v) => setMinGapMs(Math.round(v))}
          />
        </Field>
      </FieldRow>

      <GhostButton onClick={() => void detectAndPreview()} disabled={busy}>
        {busy ? 'Analyzing…' : 'Detect beats'}
      </GhostButton>

      {beats !== null ? (
        <>
          <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 6 }}>
            {beats.length} beat{beats.length === 1 ? '' : 's'} detected
            {avgBpm > 0 ? ` · ~${avgBpm} BPM avg` : ''}
          </div>
          <PrimaryButton onClick={addBeatsAsMarkers} disabled={beats.length === 0}>
            Add {beats.length} marker{beats.length === 1 ? '' : 's'}
          </PrimaryButton>
        </>
      ) : null}

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
        Sensitivity controls which onsets qualify; Min gap thins them out by keeping the
        loudest hit per window. For CapCut-style "one beat every couple of seconds", try
        Density: <b>Downbeats</b> or <b>Bars</b>.
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Section 5 — Auto Punch-In Zoom                                      */
/* ------------------------------------------------------------------ */

/**
 * Punch in on visually-overlapping video clips while the speaker is talking.
 * Detects voice activity in the selected (voice) clip's waveform, then writes
 * subtle scale_x/scale_y keyframes (1.0 → zoomFactor → 1.0 with short fades)
 * onto every clip on a DIFFERENT track that overlaps each voice region.
 *
 * Mirrors AutoDuckSection's flow: read waveform, run VAD, compute a per-clip
 * payload (here via `computeAutoZoomKeyframes` rather than the duck-target
 * stamp), then write back via writeKeyframes + IPC updateClip. pushHistory
 * happens before any writes so the user can undo in a single step.
 */
function AutoPunchInZoomSection({ clip }: Props): JSX.Element {
  const pushToast = useEditorStore((s) => s.pushToast);
  const [zoomFactor, setZoomFactor] = useState<number>(1.08);
  const [busy, setBusy] = useState<boolean>(false);

  const runZoom = async (): Promise<void> => {
    if (!clip.asset_id) {
      pushToast({ kind: 'error', message: 'No audio source on this clip.' });
      return;
    }
    setBusy(true);
    try {
      const wave = await fetchWaveformDeduped(clip.asset_id);
      if (!wave || wave.length === 0) {
        pushToast({ kind: 'error', message: 'No waveform available.' });
        return;
      }

      const store = useTimelineStore.getState();
      const allClips = store.clips;

      const updates = computeAutoZoomKeyframes(clip, wave, allClips, {
        zoomFactor,
      });

      if (updates.length === 0) {
        pushToast({ kind: 'info', message: 'No video clips overlap detected speech.' });
        return;
      }

      // Single history entry covers every keyframe write below.
      store.pushHistory();

      let applied = 0;
      for (const update of updates) {
        const target = useTimelineStore.getState().clips.find((c) => c.id === update.clipId);
        if (!target) continue;

        // Merge into any existing keyframes — keep other tracks (position, opacity, etc.)
        // intact, and overwrite ONLY scale_x / scale_y so re-running the action is
        // idempotent. Stale punch-in keyframes from a previous run are replaced wholesale.
        const existing = parseKeyframes(target.effects_json);
        const nextTracks = {
          ...existing,
          scale_x: toKeyframes(update.scaleXKfs) as Keyframe[],
          scale_y: toKeyframes(update.scaleYKfs) as Keyframe[],
        };
        const nextEffectsJson = writeKeyframes(target.effects_json, nextTracks);

        try {
          const updated = await window.snipette.timeline.updateClip(target.id, {
            effects_json: nextEffectsJson,
          });
          useTimelineStore.getState().replaceClip(updated);
          applied += 1;
        } catch {
          // Individual failures shouldn't abort the whole batch.
        }
      }

      if (applied === 0) {
        pushToast({ kind: 'error', message: 'Failed to apply auto zoom to any clips.' });
        return;
      }
      pushToast({
        kind: 'success',
        message: `Auto zoom: punched in on ${applied} clip${applied === 1 ? '' : 's'}.`,
      });
    } catch (e) {
      pushToast({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Auto zoom failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      title="Auto Punch-In Zoom"
      description="Subtly zoom in on overlapping video clips while this voice clip is talking. Adds scale keyframes you can fine-tune later."
    >
      <FieldRow>
        <Field label={`Zoom amount · ${zoomFactor.toFixed(2)}×`}>
          <Slider
            value={zoomFactor}
            min={1.02}
            max={1.2}
            step={0.01}
            onChange={setZoomFactor}
            onCommit={setZoomFactor}
          />
        </Field>
      </FieldRow>

      <PrimaryButton onClick={() => void runZoom()} disabled={busy}>
        {busy ? 'Detecting…' : 'Apply auto zoom'}
      </PrimaryButton>

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
        Adds 4 scale keyframes per voice region (180 ms ramp in / out). Re-running the
        action replaces previous auto-zoom keyframes. Undo to revert.
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Section 6 — Beat-Sync Auto-Cut                                      */
/* ------------------------------------------------------------------ */

/**
 * Split every visually-overlapping VIDEO clip at each detected beat in this
 * music clip. Detection runs on-demand via the existing `media.detectBeats`
 * IPC; results are NOT cached between runs so the user can tweak Density in
 * the Beat Detection section and re-run without a stale list.
 *
 * Apply algorithm:
 *   1. Detect beats on the music clip's asset (source ms).
 *   2. Convert to timeline ms via `beatsSourceToTimeline` (matches the marker
 *      placement math in BeatDetectionSection so the two stay in sync).
 *   3. Build a plan: for each VIDEO clip overlapping the music clip's
 *      timeline range, list the beats that fall strictly inside its window.
 *   4. Iterate the plans; per clip, split LEFT→RIGHT. After each split the
 *      "current" clip becomes the RIGHT-HAND piece (which contains the
 *      remaining beats), so we keep splitting that piece for the next beat.
 *      This avoids the kind of stale-id bug that plagued naive split loops.
 */
function BeatSyncAutoCutSection({ clip }: Props): JSX.Element {
  const pushToast = useEditorStore((s) => s.pushToast);
  // Reuse the same controls as BeatDetectionSection so the result feels
  // consistent. Default to "Downbeats" — CapCut-style cuts are usually 1/s.
  const [threshold, setThreshold] = useState<number>(1.5);
  const [minGapMs, setMinGapMs] = useState<number>(1000);
  const [busy, setBusy] = useState<boolean>(false);

  const runCut = async (): Promise<void> => {
    if (!clip.asset_id) {
      pushToast({ kind: 'error', message: 'No audio source on this clip.' });
      return;
    }
    setBusy(true);
    try {
      // Step 1 — detect beats (source ms).
      const sourceBeats = await window.snipette.media.detectBeats(clip.asset_id, {
        threshold,
        minIntervalMs: minGapMs,
      });
      if (!sourceBeats || sourceBeats.length === 0) {
        pushToast({ kind: 'info', message: 'No beats detected on this clip.' });
        return;
      }

      // Step 2 — convert to timeline ms (filters to source window + applies speed).
      const timelineBeats = beatsSourceToTimeline(sourceBeats, clip);
      if (timelineBeats.length === 0) {
        pushToast({ kind: 'info', message: 'No beats fall inside this clip.' });
        return;
      }

      const store = useTimelineStore.getState();
      const videoTrackIds = new Set(store.tracks.filter((t) => t.type === 'video').map((t) => t.id));

      // Step 3 — build the cut plan against the CURRENT clip snapshot.
      const plans = computeBeatCutPlan(timelineBeats, clip, store.clips, videoTrackIds);
      if (plans.length === 0) {
        pushToast({ kind: 'info', message: 'No video clips overlap the beat range.' });
        return;
      }

      // Single history entry for the whole batch — one undo restores everything.
      store.pushHistory();

      // Step 4 — iterate and split. Track "currentId" because each split returns
      // a new right-hand clip whose id replaces the original for subsequent beats.
      let totalSplits = 0;
      let totalClips = 0;
      let failures = 0;

      for (const plan of plans) {
        let currentId = plan.clipId;
        let splitsForClip = 0;
        for (const at of plan.splitPointsMs) {
          // Re-fetch the live clip; defensive against any prior partial state.
          const live = useTimelineStore.getState().clips.find((c) => c.id === currentId);
          if (!live) {
            failures += 1;
            break;
          }
          const liveEnd = live.start_time_ms + live.duration_ms;
          // Skip splits that no longer fall strictly inside this piece — the previous
          // split may have moved the cut point onto an edge.
          if (at <= live.start_time_ms + 1 || at >= liveEnd - 1) continue;

          try {
            const [left, right] = await window.snipette.timeline.splitClip(currentId, at);
            useTimelineStore.getState().replaceClip(left);
            useTimelineStore.getState().addClip(right);
            currentId = right.id;
            splitsForClip += 1;
          } catch {
            failures += 1;
            break;
          }
        }
        if (splitsForClip > 0) {
          totalSplits += splitsForClip;
          totalClips += 1;
        }
      }

      useTimelineStore.getState().computeDuration();

      if (totalSplits === 0) {
        pushToast({
          kind: 'error',
          message: failures > 0 ? 'Beat-sync cut failed.' : 'No cuts applied.',
        });
        return;
      }
      pushToast({
        kind: 'success',
        message: `Beat-sync: ${totalSplits} cut${totalSplits === 1 ? '' : 's'} across ${totalClips} clip${totalClips === 1 ? '' : 's'}.`,
      });
    } catch (e) {
      pushToast({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Beat-sync auto-cut failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      title="Beat-Sync Auto-Cut"
      description="Split overlapping video clips at every beat in this music clip. Uses the same beat detector as the markers section."
    >
      <FieldRow>
        <Field label={`Sensitivity · ${threshold.toFixed(2)}× (higher = pickier)`}>
          <Slider
            value={threshold}
            min={1.05}
            max={2.5}
            onChange={setThreshold}
            onCommit={setThreshold}
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field
          label={
            minGapMs < 1000
              ? `Min gap · ${minGapMs} ms`
              : `Min gap · ${(minGapMs / 1000).toFixed(2)}s`
          }
        >
          <Slider
            value={minGapMs}
            min={120}
            max={6000}
            step={20}
            onChange={(v) => setMinGapMs(Math.round(v))}
            onCommit={(v) => setMinGapMs(Math.round(v))}
          />
        </Field>
      </FieldRow>

      <PrimaryButton onClick={() => void runCut()} disabled={busy}>
        {busy ? 'Cutting…' : 'Split video clips at each beat'}
      </PrimaryButton>

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
        Detects beats fresh each run. Higher sensitivity / longer min gap = fewer cuts. Undo
        to revert in one step.
      </div>
    </SectionCard>
  );
}
