import { useState } from 'react';
import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import { InspectorSection, Field, FieldRow } from '../RightPanel';
import { Slider } from '@/components/ui/Slider';
import { Toggle } from '@/components/ui/Toggle';
import { NumInput } from '@/components/ui/Input';
import { Icons } from '@/components/ui/icons';
import type { Clip, ColorGrade } from '@shared/types';
import { DEFAULT_GRADE } from '@/utils/color';
import { durationForSpeed } from '@/utils/time';
import { MOTION_FX_LIBRARY, isMotionFxType, parseEffects, serializeEffects, type MotionEffect } from '@/utils/motion-fx';
import { KeyframePanel } from './KeyframePanel';
import { parseKeyframes, writeKeyframes } from '@/utils/keyframes';
import { SPEED_RAMP_PRESETS, type SpeedRampPreset } from '@/utils/speed-ramps';

interface Props {
  clip: Clip;
}

function parseGrade(json: string | null): ColorGrade {
  if (!json) return DEFAULT_GRADE;
  try {
    return { ...DEFAULT_GRADE, ...JSON.parse(json) };
  } catch {
    return DEFAULT_GRADE;
  }
}

export function VideoInspector({ clip }: Props): JSX.Element {
  const updateLocal = useTimelineStore((s) => s.updateClipLocal);
  const replaceClip = useTimelineStore((s) => s.replaceClip);
  // Lock aspect ratio: when on, editing one scale axis mirrors the other so the clip
  // stays proportional. Component-local state — not persisted on the clip.
  const [lockRatio, setLockRatio] = useState(false);

  /** Returns the list of clip ids this inspector should write to. If the user has
   *  selected multiple clips (Cmd+A or shift-click), edits apply to ALL of them.
   *  Otherwise just the primary inspected clip. */
  const targetIds = (): string[] => {
    const sel = useTimelineStore.getState().selectedClipIds;
    if (sel.length > 1 && sel.includes(clip.id)) return sel;
    return [clip.id];
  };

  const commit = async (updates: Partial<Clip>) => {
    const ids = targetIds();
    // Optimistic local update for every targeted clip first so the UI feels
    // instant; then persist via IPC in parallel.
    for (const id of ids) updateLocal(id, updates);
    await Promise.all(
      ids.map((id) =>
        window.snipette.timeline
          .updateClip(id, updates)
          .then((updated) => replaceClip(updated))
          .catch(() => {
            /* best-effort */
          }),
      ),
    );
  };

  /**
   * Commit a scale change while respecting the lock toggle. When locked, we copy the
   * proportional change to the OTHER axis using the existing scale_x/scale_y ratio so
   * a non-square scale (e.g. anamorphic) stays non-square.
   */
  const commitScale = async (axis: 'x' | 'y', value: number) => {
    if (!lockRatio) {
      void commit(axis === 'x' ? { scale_x: value } : { scale_y: value });
      return;
    }
    const sx = clip.scale_x === 0 ? 1 : clip.scale_x;
    const sy = clip.scale_y === 0 ? 1 : clip.scale_y;
    if (axis === 'x') {
      // Preserve the existing sy/sx ratio.
      const ratio = sy / sx;
      void commit({ scale_x: value, scale_y: value * ratio });
    } else {
      const ratio = sx / sy;
      void commit({ scale_y: value, scale_x: value * ratio });
    }
  };

  const setLive = (updates: Partial<Clip>) => {
    for (const id of targetIds()) updateLocal(id, updates);
  };

  /**
   * Speed changes have to recompute duration_ms so the clip's footprint on the timeline
   * shrinks (faster) or grows (slower) to match the consumed source window.
   */
  const setLiveSpeed = (speed: number) => {
    const duration_ms = durationForSpeed(clip.source_in_ms, clip.source_out_ms, speed);
    updateLocal(clip.id, { speed, duration_ms });
  };
  const commitSpeed = async (speed: number) => {
    const duration_ms = durationForSpeed(clip.source_in_ms, clip.source_out_ms, speed);
    useTimelineStore.getState().pushHistory();
    await commit({ speed, duration_ms });
    useTimelineStore.getState().computeDuration();
  };

  /**
   * Apply a speed ramp preset: build keyframes spanning the clip duration onto the 'speed'
   * track, preserving every other entry in effects_json. Snaps clip.speed to 1× so the ramp
   * keyframes are the sole authority on playback rate.
   */
  const applySpeedRamp = async (preset: SpeedRampPreset) => {
    useTimelineStore.getState().pushHistory();
    const existing = parseKeyframes(clip.effects_json);
    const nextTracks = { ...existing, speed: preset.build(clip.duration_ms) };
    const nextEffects = writeKeyframes(clip.effects_json, nextTracks);
    await commit({ effects_json: nextEffects, speed: 1 });
  };

  const clearSpeedRamp = async () => {
    const existing = parseKeyframes(clip.effects_json);
    if (!existing.speed || existing.speed.length === 0) return;
    useTimelineStore.getState().pushHistory();
    const nextTracks = { ...existing };
    delete nextTracks.speed;
    const nextEffects = writeKeyframes(clip.effects_json, nextTracks);
    await commit({ effects_json: nextEffects });
  };

  const hasSpeedRamp = (parseKeyframes(clip.effects_json).speed ?? []).length > 0;

  const grade = parseGrade(clip.color_grade_json);
  const setGrade = (next: Partial<ColorGrade>) => {
    const merged = { ...grade, ...next };
    commit({ color_grade_json: JSON.stringify(merged) });
  };

  return (
    <div>
      <InspectorSection title="Clip" defaultOpen>
        <FieldRow>
          <Field label="Opacity">
            <Slider value={clip.opacity} min={0} max={1} onChange={(v) => setLive({ opacity: v })} onCommit={(v) => commit({ opacity: v })} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Volume">
            <Slider value={clip.volume} min={0} max={2} onChange={(v) => setLive({ volume: v })} onCommit={(v) => commit({ volume: v })} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label={`Speed · ${clip.speed.toFixed(2)}×`}>
            <Slider value={clip.speed} min={0.1} max={4} onChange={setLiveSpeed} onCommit={commitSpeed} />
          </Field>
          <Field label="Reverse">
            <Toggle on={!!clip.is_reversed} onChange={(on) => commit({ is_reversed: on ? 1 : 0 })} />
          </Field>
        </FieldRow>
        <div style={{ marginTop: 8 }}>
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--text-muted)',
              marginBottom: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>Speed ramps</span>
            {hasSpeedRamp && (
              <button
                className="sn-btn-ghost"
                style={{ fontSize: 10, padding: '2px 6px' }}
                onClick={() => void clearSpeedRamp()}
                title="Remove speed keyframes"
              >
                Clear
              </button>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {SPEED_RAMP_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className="sn-btn-ghost"
                style={{ justifyContent: 'center', fontSize: 11, padding: '6px 8px' }}
                onClick={() => void applySpeedRamp(preset)}
                title={preset.description}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </div>
      </InspectorSection>

      <InspectorSection title="Transform">
        <FieldRow>
          <Field label="X"><NumInput value={clip.position_x} suffix="px" onChange={(v) => commit({ position_x: v })} /></Field>
          <Field label="Y"><NumInput value={clip.position_y} suffix="px" onChange={(v) => commit({ position_y: v })} /></Field>
        </FieldRow>
        <FieldRow>
          <Field label="Scale X">
            <NumInput value={clip.scale_x.toFixed(2)} onChange={(v) => void commitScale('x', v)} />
          </Field>
          <Field label="Scale Y">
            <NumInput value={clip.scale_y.toFixed(2)} onChange={(v) => void commitScale('y', v)} />
          </Field>
          <button
            className={`sn-icon-btn ${lockRatio ? 'active' : ''}`}
            style={{
              marginTop: 14,
              color: lockRatio ? 'var(--accent-primary)' : undefined,
              borderColor: lockRatio ? 'var(--accent-primary)' : undefined,
            }}
            onClick={() => setLockRatio((v) => !v)}
            title={lockRatio ? 'Aspect locked — click to unlock' : 'Click to lock aspect ratio'}
            aria-pressed={lockRatio}
          >
            <Icons.Link size={11} />
          </button>
        </FieldRow>
        <FieldRow>
          <Field label="Rotate"><NumInput value={clip.rotation} suffix="°" onChange={(v) => commit({ rotation: v })} /></Field>
          <Field label="Flip">
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="sn-icon-btn" style={{ width: 24, height: 24 }} onClick={() => commit({ scale_x: -clip.scale_x })} title="Flip H">
                <Icons.FlipH size={12} />
              </button>
              <button className="sn-icon-btn" style={{ width: 24, height: 24, transform: 'rotate(90deg)' }} onClick={() => commit({ scale_y: -clip.scale_y })} title="Flip V">
                <Icons.FlipH size={12} />
              </button>
            </div>
          </Field>
        </FieldRow>
      </InspectorSection>

      <InspectorSection title="Color grade">
        <FieldRow>
          <Field label="Exposure">
            <Slider value={(grade.exposure + 1) / 2} min={0} max={1} onChange={(v) => setGrade({ exposure: v * 2 - 1 })} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Contrast">
            <Slider value={(grade.contrast + 100) / 200} min={0} max={1} onChange={(v) => setGrade({ contrast: v * 200 - 100 })} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Saturation">
            <Slider value={(grade.saturation + 100) / 200} min={0} max={1} onChange={(v) => setGrade({ saturation: v * 200 - 100 })} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Temperature">
            <Slider value={(grade.temperature + 100) / 200} min={0} max={1} onChange={(v) => setGrade({ temperature: v * 200 - 100 })} />
          </Field>
          <Field label="Tint">
            <Slider value={(grade.tint + 100) / 200} min={0} max={1} onChange={(v) => setGrade({ tint: v * 200 - 100 })} />
          </Field>
        </FieldRow>
        <button className="sn-btn-ghost" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }} onClick={() => commit({ color_grade_json: null })}>
          <Icons.Sliders size={12} /> Reset grade
        </button>
      </InspectorSection>

      <InspectorSection title="Keyframes">
        <KeyframePanel clip={clip} />
      </InspectorSection>

      <InspectorSection title="Effects">
        <ClipEffectsList clip={clip} />
      </InspectorSection>
    </div>
  );
}

function ClipEffectsList({ clip }: { clip: Clip }) {
  const replaceClip = useTimelineStore((s) => s.replaceClip);
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const openEffectsDrawer = useEditorStore((s) => s.openEffectsDrawer);
  const pushToast = useEditorStore((s) => s.pushToast);
  // `effects_json` is a shared bag with motion FX, audio FX, keyframes, filter-preset
  // metadata, and auto-duck sidecars. The Motion FX inspector must touch ONLY motion-FX
  // entries; if we mix audio FX or keyframes into this list (as a previous version did),
  // X clicks remove the wrong row and intensity sliders write to entries that ignore the
  // field — including breaking audio FX. Keep both: the original array (for mutation) and
  // a filtered + indexed view (for rendering).
  const allEntries = parseEffects(clip.effects_json);
  const motionEntries: { effect: MotionEffect; fullIdx: number }[] = [];
  allEntries.forEach((e, idx) => {
    if (isMotionFxType(e.type)) motionEntries.push({ effect: e, fullIdx: idx });
  });

  const removeAt = async (fullIdx: number) => {
    pushHistory();
    const next = allEntries.slice();
    next.splice(fullIdx, 1);
    const updated = await window.snipette.timeline.updateClip(clip.id, {
      effects_json: serializeEffects(next),
    });
    replaceClip(updated);
    pushToast({ kind: 'success', message: 'Effect removed.' });
  };

  const setIntensity = async (fullIdx: number, intensity: number) => {
    const next = allEntries.map((e: MotionEffect, i) => (i === fullIdx ? { ...e, intensity } : e));
    const updated = await window.snipette.timeline.updateClip(clip.id, {
      effects_json: serializeEffects(next),
    });
    replaceClip(updated);
  };

  const clearAll = async () => {
    if (motionEntries.length === 0) return;
    pushHistory();
    // Drop every motion FX entry; keep everything else (audio FX, keyframes, filter-preset, etc.).
    const next = allEntries.filter((e) => !isMotionFxType(e.type));
    const updated = await window.snipette.timeline.updateClip(clip.id, {
      effects_json: serializeEffects(next),
    });
    replaceClip(updated);
    pushToast({ kind: 'success', message: 'All motion FX cleared' });
  };

  return (
    <div>
      {motionEntries.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          No motion FX. Open the Effects drawer to add Shake, Zoom Pulse, Ken Burns, etc.
        </div>
      ) : (
        motionEntries.map(({ effect, fullIdx }) => {
          const meta = MOTION_FX_LIBRARY.find((m) => m.type === effect.type);
          return (
            <div
              key={`${effect.type}-${fullIdx}`}
              style={{
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 6,
                padding: 8,
                marginBottom: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{meta?.name ?? effect.type}</span>
                <button
                  className="sn-icon-btn"
                  style={{ width: 18, height: 18 }}
                  onClick={() => void removeAt(fullIdx)}
                  aria-label="Remove"
                  title="Remove this effect"
                >
                  <Icons.X size={11} />
                </button>
              </div>
              <div style={{ marginTop: 6 }}>
                <Slider
                  value={effect.intensity ?? meta?.defaultIntensity ?? 0.5}
                  min={0}
                  max={1}
                  onChange={(v) => void setIntensity(fullIdx, v)}
                />
              </div>
            </div>
          );
        })
      )}
      <button
        className="sn-btn-ghost"
        style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
        onClick={openEffectsDrawer}
      >
        <Icons.Sparkle size={12} /> Browse effects
      </button>
      {motionEntries.length > 0 && (
        <button
          onClick={() => void clearAll()}
          style={{
            marginTop: 6,
            padding: '6px 10px',
            fontSize: 10.5,
            color: 'var(--text-secondary)',
            background: 'transparent',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 6,
            width: '100%',
            cursor: 'pointer',
          }}
        >
          Clear motion FX
        </button>
      )}
    </div>
  );
}
