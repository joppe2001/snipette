import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import { InspectorSection, Field, FieldRow } from '../RightPanel';
import { Slider } from '@/components/ui/Slider';
import { Toggle } from '@/components/ui/Toggle';
import { NumInput } from '@/components/ui/Input';
import { durationForSpeed } from '@/utils/time';
import { isAudioFxType, parseEffectsArray, type RawEffectEntry } from '@/utils/audio-fx';
import { VOICE_PRESETS, type VoicePreset } from '@/utils/voice-presets';
import type { Clip } from '@shared/types';
import { AudioFxControls } from './AudioFxControls';
import { AudioIntelligence } from './AudioIntelligence';

export function AudioInspector({ clip }: { clip: Clip }): JSX.Element {
  const updateLocal = useTimelineStore((s) => s.updateClipLocal);
  const replaceClip = useTimelineStore((s) => s.replaceClip);
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const pushToast = useEditorStore((s) => s.pushToast);

  /** When multiple clips are selected (Cmd+A / shift-click), inspector edits
   *  apply to ALL of them. Otherwise just the primary inspected clip. */
  const targetIds = (): string[] => {
    const sel = useTimelineStore.getState().selectedClipIds;
    if (sel.length > 1 && sel.includes(clip.id)) return sel;
    return [clip.id];
  };

  const setLive = (updates: Partial<Clip>) => {
    for (const id of targetIds()) updateLocal(id, updates);
  };

  const commit = async (updates: Partial<Clip>) => {
    const ids = targetIds();
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
   * Apply a voice preset by REPLACING the clip's existing audio FX list. Non-audio
   * entries on `effects_json` (motion FX, keyframes) are preserved verbatim.
   */
  const applyVoicePreset = async (preset: VoicePreset): Promise<void> => {
    pushHistory();
    const allEntries: RawEffectEntry[] = parseEffectsArray(clip.effects_json);
    const nonAudio = allEntries.filter((e) => !isAudioFxType(e.type));
    const merged: RawEffectEntry[] = [...nonAudio, ...preset.fx];
    try {
      const updated = await window.snipette.timeline.updateClip(clip.id, {
        effects_json: JSON.stringify(merged),
      });
      replaceClip(updated);
      pushToast({ kind: 'success', message: `Applied "${preset.name}" preset` });
    } catch {
      pushToast({ kind: 'error', message: 'Failed to apply preset.' });
    }
  };

  const clearVoicePreset = async (): Promise<void> => {
    pushHistory();
    const allEntries: RawEffectEntry[] = parseEffectsArray(clip.effects_json);
    const nonAudio = allEntries.filter((e) => !isAudioFxType(e.type));
    try {
      const updated = await window.snipette.timeline.updateClip(clip.id, {
        effects_json: JSON.stringify(nonAudio),
      });
      replaceClip(updated);
      pushToast({ kind: 'success', message: 'Cleared audio FX' });
    } catch {
      pushToast({ kind: 'error', message: 'Failed to clear FX.' });
    }
  };

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

  return (
    <div>
      <InspectorSection title="Audio" defaultOpen>
        <FieldRow>
          <Field label="Volume">
            <Slider value={Math.min(2, clip.volume) / 2} min={0} max={1} onChange={(v) => setLive({ volume: v * 2 })} onCommit={(v) => commit({ volume: v * 2 })} />
          </Field>
          <Field label="—"><NumInput value={(clip.volume * 100).toFixed(0)} suffix="%" /></Field>
        </FieldRow>
        <FieldRow>
          <Field label={`Speed · ${clip.speed.toFixed(2)}×`}>
            <Slider
              value={Math.min(4, clip.speed) / 4}
              min={0.025}
              max={1}
              onChange={(v) => setLiveSpeed(v * 4)}
              onCommit={(v) => commitSpeed(v * 4)}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Reverse"><Toggle on={!!clip.is_reversed} onChange={(on) => commit({ is_reversed: on ? 1 : 0 })} /></Field>
        </FieldRow>
      </InspectorSection>

      <InspectorSection title="Voice presets">
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
          One-click chains tuned for spoken voice. Replaces the audio FX list — tweak
          individual values in the section below.
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 6,
          }}
        >
          {VOICE_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => void applyVoicePreset(p)}
              title={p.description}
              style={{
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-base)',
                color: 'var(--text-primary)',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                position: 'relative',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = p.accent;
                e.currentTarget.style.boxShadow = `0 0 0 1px ${p.accent}40`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-subtle)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: p.accent,
                    boxShadow: `0 0 6px ${p.accent}`,
                  }}
                />
                {p.name}
              </div>
              <div style={{ fontSize: 9.5, color: 'var(--text-muted)', marginTop: 4, fontWeight: 400, lineHeight: 1.3 }}>
                {p.description}
              </div>
            </button>
          ))}
        </div>
        <button
          onClick={() => void clearVoicePreset()}
          style={{
            marginTop: 8,
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
          Clear audio FX
        </button>
      </InspectorSection>

      <InspectorSection title="Audio FX">
        <AudioFxControls clip={clip} />
      </InspectorSection>

      <InspectorSection title="Audio Intelligence">
        <AudioIntelligence clip={clip} />
      </InspectorSection>
    </div>
  );
}
