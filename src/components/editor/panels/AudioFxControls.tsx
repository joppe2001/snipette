import { useState } from 'react';
import type { Clip } from '@shared/types';
import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import { Slider } from '@/components/ui/Slider';
import { Toggle } from '@/components/ui/Toggle';
import { Icons } from '@/components/ui/icons';
import {
  AUDIO_FX_LIBRARY,
  audioFxOnly,
  defaultParams,
  isAudioFxType,
  parseEffectsArray,
  type AudioFx,
  type AudioFxDef,
  type AudioFxType,
  type RawEffectEntry,
} from '@/utils/audio-fx';

interface Props {
  clip: Clip;
}

/**
 * Audio FX list + add menu. The clip's `effects_json` is a single array shared with
 * motion FX (Shake, ZoomPulse, etc.) — we only touch the entries whose type starts with
 * `audio-` and pass the rest through verbatim on every write.
 */
export function AudioFxControls({ clip }: Props): JSX.Element {
  const replaceClip = useTimelineStore((s) => s.replaceClip);
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const pushToast = useEditorStore((s) => s.pushToast);
  const [pickerOpen, setPickerOpen] = useState(false);

  const allEntries: RawEffectEntry[] = parseEffectsArray(clip.effects_json);
  const audioFx: AudioFx[] = audioFxOnly(allEntries);

  /**
   * Rewrite `effects_json` with a new audio FX list. Non-audio entries (motion FX) keep
   * their relative order; the audio list is rebuilt fresh from `nextAudio`.
   */
  const writeAudioFx = async (nextAudio: AudioFx[]): Promise<void> => {
    const nonAudio = allEntries.filter((e) => !isAudioFxType(e.type));
    const merged: RawEffectEntry[] = [...nonAudio, ...nextAudio];
    try {
      const updated = await window.snipette.timeline.updateClip(clip.id, {
        effects_json: JSON.stringify(merged),
      });
      replaceClip(updated);
    } catch {
      pushToast({ kind: 'error', message: 'Failed to update audio FX.' });
    }
  };

  const addFx = (type: AudioFxType): void => {
    pushHistory();
    const next: AudioFx[] = [...audioFx, { type, params: defaultParams(type) }];
    setPickerOpen(false);
    void writeAudioFx(next);
  };

  const removeAt = (idx: number): void => {
    pushHistory();
    const next = audioFx.slice();
    next.splice(idx, 1);
    void writeAudioFx(next);
    pushToast({ kind: 'success', message: 'Audio FX removed.' });
  };

  const setParam = (idx: number, key: string, value: number): void => {
    const next = audioFx.map((fx, i) =>
      i === idx ? { ...fx, params: { ...fx.params, [key]: value } } : fx,
    );
    void writeAudioFx(next);
  };

  const commitParam = (idx: number, key: string, value: number): void => {
    pushHistory();
    setParam(idx, key, value);
  };

  const toggleBypass = (idx: number): void => {
    pushHistory();
    const next = audioFx.map((fx, i) =>
      i === idx ? { ...fx, bypassed: !(fx.bypassed === true) } : fx,
    );
    void writeAudioFx(next);
  };

  const resetFx = (idx: number): void => {
    pushHistory();
    const target = audioFx[idx];
    if (!target) return;
    const next = audioFx.map((fx, i) =>
      i === idx ? { type: fx.type, params: defaultParams(fx.type), bypassed: fx.bypassed } : fx,
    );
    void writeAudioFx(next);
    pushToast({ kind: 'success', message: 'FX reset to defaults' });
  };

  return (
    <div>
      {audioFx.length === 0 ? (
        <EmptyState />
      ) : (
        audioFx.map((fx, idx) => {
          const def: AudioFxDef | undefined = AUDIO_FX_LIBRARY.find((d) => d.type === fx.type);
          return (
            <FxCard
              key={`${fx.type}-${idx}`}
              fx={fx}
              def={def}
              onToggleBypass={() => toggleBypass(idx)}
              onReset={() => resetFx(idx)}
              onRemove={() => removeAt(idx)}
              onParamChange={(key, v) => setParam(idx, key, v)}
              onParamCommit={(key, v) => commitParam(idx, key, v)}
            />
          );
        })
      )}

      <FxPicker
        open={pickerOpen}
        toggle={() => setPickerOpen((v) => !v)}
        onPick={addFx}
        existingTypes={new Set(audioFx.map((f) => f.type))}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Subcomponents
// ----------------------------------------------------------------------------

function EmptyState() {
  return (
    <div
      style={{
        padding: '14px 12px',
        background: 'var(--bg-base)',
        border: '1px dashed var(--border-subtle)',
        borderRadius: 8,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: 'rgba(200, 242, 58, 0.12)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 6,
          color: 'var(--accent-primary)',
        }}
      >
        <Icons.Volume size={14} />
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-primary)', fontWeight: 600 }}>
        No audio FX yet
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
        Try a Voice preset above for a one-click chain, or add individual FX below.
      </div>
    </div>
  );
}

function FxCard({
  fx,
  def,
  onToggleBypass,
  onReset,
  onRemove,
  onParamChange,
  onParamCommit,
}: {
  fx: AudioFx;
  def: AudioFxDef | undefined;
  onToggleBypass: () => void;
  onReset: () => void;
  onRemove: () => void;
  onParamChange: (key: string, v: number) => void;
  onParamCommit: (key: string, v: number) => void;
}) {
  const bypassed = fx.bypassed === true;
  const accent = def?.accent ?? 'var(--accent-primary)';
  return (
    <div
      style={{
        position: 'relative',
        background: 'var(--bg-base)',
        border: '1px solid var(--border-subtle)',
        borderLeft: `3px solid ${bypassed ? 'var(--border-subtle)' : accent}`,
        borderRadius: 8,
        padding: '10px 10px 10px 12px',
        marginBottom: 8,
        opacity: bypassed ? 0.55 : 1,
        transition: 'opacity .15s',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: bypassed ? 0 : 8,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: accent,
            boxShadow: bypassed ? 'none' : `0 0 6px ${accent}`,
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>
            {def?.name ?? fx.type}
          </div>
          {def?.description && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
              {def.description}
            </div>
          )}
        </div>
        <Toggle
          on={!bypassed}
          onChange={onToggleBypass}
          ariaLabel={bypassed ? 'Enable FX' : 'Bypass FX'}
        />
        <button
          className="sn-icon-btn"
          style={{ width: 22, height: 22, fontSize: 13 }}
          onClick={onReset}
          title="Reset to defaults"
          aria-label="Reset"
        >
          ↺
        </button>
        <button
          className="sn-icon-btn"
          style={{ width: 22, height: 22 }}
          onClick={onRemove}
          title="Remove FX"
          aria-label="Remove"
        >
          <Icons.X size={11} />
        </button>
      </div>

      {!bypassed &&
        def?.params.map((spec) => {
          const current = fx.params[spec.key] ?? spec.defaultValue;
          return (
            <div key={spec.key} style={{ marginTop: 6 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  fontSize: 10.5,
                  marginBottom: 4,
                }}
              >
                <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{spec.label}</span>
                <span className="mono" style={{ color: 'var(--text-primary)', fontSize: 11 }}>
                  {formatValue(current, spec.suffix, spec.min, spec.max)}
                </span>
              </div>
              <Slider
                value={current}
                min={spec.min}
                max={spec.max}
                step={spec.step}
                onChange={(v) => onParamChange(spec.key, v)}
                onCommit={(v) => onParamCommit(spec.key, v)}
              />
            </div>
          );
        })}
    </div>
  );
}

function FxPicker({
  open,
  toggle,
  onPick,
  existingTypes,
}: {
  open: boolean;
  toggle: () => void;
  onPick: (type: AudioFxType) => void;
  existingTypes: Set<AudioFxType>;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <button
        className="sn-btn-ghost"
        style={{ width: '100%', justifyContent: 'center' }}
        onClick={toggle}
      >
        <Icons.Plus size={12} /> {open ? 'Close' : 'Add audio FX'}
      </button>
      {open && (
        <div
          style={{
            marginTop: 6,
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 6,
          }}
        >
          {AUDIO_FX_LIBRARY.map((def) => {
            const already = existingTypes.has(def.type);
            const accent = def.accent ?? 'var(--accent-primary)';
            return (
              <button
                key={def.type}
                onClick={() => onPick(def.type)}
                style={{
                  position: 'relative',
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-base)',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  overflow: 'hidden',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = accent;
                  e.currentTarget.style.boxShadow = `0 0 0 1px ${accent}30`;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-subtle)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: accent,
                      boxShadow: `0 0 6px ${accent}`,
                    }}
                  />
                  <span style={{ fontSize: 11.5, fontWeight: 700 }}>{def.name}</span>
                  {already && (
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontSize: 9,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: 0.6,
                      }}
                    >
                      ×{Array.from(existingTypes).filter((t) => t === def.type).length}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.3 }}>
                  {def.description}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Format a slider value for the field label. Renders human-friendly text rather than
 * raw floats — % for 0..1 ranges, signed dB, signed semitones, X:1 for ratios.
 */
function formatValue(value: number, suffix?: string, min?: number, max?: number): string {
  if (suffix === 'dB') {
    const rounded = Math.round(value);
    const sign = rounded > 0 ? '+' : '';
    return `${sign}${rounded} dB`;
  }
  if (suffix === ':1') return `${value.toFixed(1)}:1`;
  if (suffix === 'st') {
    const rounded = Math.round(value);
    if (rounded === 0) return '0';
    return `${rounded > 0 ? '+' : ''}${rounded} st`;
  }
  if (suffix === '%') {
    // For 0..1 ranges, render as percentage.
    if (min === 0 && (max === 1 || max === undefined)) {
      return `${Math.round(value * 100)}%`;
    }
    return `${Math.round(value)}%`;
  }
  if (suffix) return `${value.toFixed(2)} ${suffix}`;
  return value.toFixed(2);
}

