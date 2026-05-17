import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useEditorStore } from '@/store/editor.store';
import { useProjectStore } from '@/store/project.store';
import { useTimelineStore } from '@/store/timeline.store';
import { Icons } from '@/components/ui/icons';
import { Slider } from '@/components/ui/Slider';
import {
  dialogueAnimation,
  dialogueBubbleStyle,
  dialogueLineDurations,
  dialoguePositionX,
  parseDialogueScript,
  type DialogueSpeaker,
} from '@/utils/dialogue';
import type { ClipCreate, MediaAsset, Track, TtsVoice } from '@shared/types';

type SpeakerVoiceMode = 'none' | 'tts' | 'asset';
interface SpeakerVoiceConfig {
  mode: SpeakerVoiceMode;
  ttsVoice?: string;
  assetId?: string;
}

const PLACEHOLDER = `Joppe: hey, ready to record?
Friend: yeah just give me a sec
Joppe: take your time
Friend: ok let's go`;

export function DialogueModal(): JSX.Element {
  const open = useEditorStore((s) => s.dialogueOpen);
  const close = useEditorStore((s) => s.closeDialogue);
  const pushToast = useEditorStore((s) => s.pushToast);
  const project = useProjectStore((s) => s.activeProject);
  const tracks = useTimelineStore((s) => s.tracks);
  const upsertTrack = useTimelineStore((s) => s.upsertTrack);
  const addClipLocal = useTimelineStore((s) => s.addClip);
  const playheadMs = useTimelineStore((s) => s.playheadMs);

  const [script, setScript] = useState<string>('');
  const [msPerChar, setMsPerChar] = useState(80);
  const [minMs, setMinMs] = useState(1200);
  const [gapMs, setGapMs] = useState(200);
  const [busy, setBusy] = useState(false);
  // Per-speaker voice configuration. Keyed by slot index (0..3). User can leave a
  // speaker on 'none' for plain text, pick a TTS voice to auto-generate audio, or pick
  // a library asset whose timeline gets sliced across this speaker's lines.
  const [voiceConfig, setVoiceConfig] = useState<Record<number, SpeakerVoiceConfig>>({});
  const [ttsVoices, setTtsVoices] = useState<TtsVoice[]>([]);
  const assets = useProjectStore((s) => s.assets);
  const upsertAsset = useProjectStore((s) => s.upsertAsset);

  useEffect(() => {
    if (!open) return;
    // Probe the OS once per modal open — list of voices is stable enough.
    void window.snipette.tts.listVoices().then(setTtsVoices).catch(() => setTtsVoices([]));
  }, [open]);

  const audioAssets = useMemo(() => assets.filter((a) => a.type === 'audio'), [assets]);

  const { lines, speakers } = useMemo(
    () => parseDialogueScript(script),
    [script],
  );
  const durations = useMemo(
    () => dialogueLineDurations(lines, { msPerChar, minMs, gapMs }),
    [lines, msPerChar, minMs, gapMs],
  );
  const totalDuration = durations.length > 0
    ? durations[durations.length - 1].startMs + durations[durations.length - 1].durationMs
    : 0;

  const place = async () => {
    if (!project || lines.length === 0) return;
    setBusy(true);
    try {
      // Text track — first one wins; auto-create if needed.
      let textTrack: Track | undefined = tracks.find((t) => t.type === 'text');
      if (!textTrack) {
        textTrack = await window.snipette.timeline.addTrack({
          project_id: project.id,
          type: 'text',
        });
        upsertTrack(textTrack);
      }
      // Audio track — needed only if at least one speaker has TTS or library-asset mode.
      const needsAudio = Object.values(voiceConfig).some((c) => c?.mode === 'tts' || c?.mode === 'asset');
      let audioTrack: Track | undefined = needsAudio
        ? tracks.find((t) => t.type === 'audio')
        : undefined;
      if (needsAudio && !audioTrack) {
        audioTrack = await window.snipette.timeline.addTrack({
          project_id: project.id,
          type: 'audio',
        });
        upsertTrack(audioTrack);
      }

      useTimelineStore.getState().pushHistory();

      // For library-asset mode, source_in advances per line within the same asset so a
      // single back-to-back recording slices cleanly across the speaker's dialogue.
      const assetCursor: Record<number, number> = {};

      let createdTextCount = 0;
      let createdAudioCount = 0;
      const errors: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const { startMs, durationMs } = durations[i];
        const absStart = Math.max(0, playheadMs + startMs);
        const style = dialogueBubbleStyle(line.slot);
        const animation = dialogueAnimation(line.slot);
        const create: ClipCreate = {
          track_id: textTrack.id,
          project_id: project.id,
          start_time_ms: absStart,
          duration_ms: durationMs,
          source_in_ms: 0,
          source_out_ms: durationMs,
          text_content: line.text,
          text_style_json: JSON.stringify(style),
        };
        const created = await window.snipette.timeline.addClip(textTrack.id, create);
        const updated = await window.snipette.timeline.updateClip(created.id, {
          position_x: dialoguePositionX(line.slot),
          text_animation_json: JSON.stringify({
            in_preset: animation.in_preset ?? 'None',
            in_ms: animation.in_ms ?? 240,
            out_preset: animation.out_preset ?? 'None',
            out_ms: animation.out_ms ?? 200,
            loop_preset: animation.loop_preset ?? 'None',
            fade_with_transition: false,
            typewriter_cps: 14,
          }),
        });
        addClipLocal(updated);
        createdTextCount++;

        // Audio companion — TTS or library asset, if configured for this speaker.
        const cfg = voiceConfig[line.slot];
        if (!cfg || cfg.mode === 'none' || !audioTrack) continue;

        try {
          let assetId: string;
          let sourceInMs = 0;
          let sourceOutMs = durationMs;
          if (cfg.mode === 'tts') {
            // Generate a per-line TTS audio file; resulting asset feeds a fresh clip.
            const generated: MediaAsset = await window.snipette.tts.generate({
              project_id: project.id,
              text: line.text,
              voice: cfg.ttsVoice,
              base_name: `tts_${line.speaker}`,
            });
            upsertAsset(generated);
            assetId = generated.id;
            sourceInMs = 0;
            sourceOutMs = generated.duration_ms ?? durationMs;
          } else {
            // Library asset — advance the per-speaker cursor and slice durationMs out.
            if (!cfg.assetId) continue;
            const asset = assets.find((a) => a.id === cfg.assetId);
            if (!asset) {
              errors.push(`${line.speaker}: source asset missing`);
              continue;
            }
            const total = asset.duration_ms ?? 0;
            if (total <= 0) {
              errors.push(`${line.speaker}: source asset has zero duration`);
              continue;
            }
            const cursor = assetCursor[line.slot] ?? 0;
            if (cursor >= total) {
              errors.push(`${line.speaker}: ran out of audio on line ${i + 1}`);
              continue;
            }
            assetId = asset.id;
            sourceInMs = cursor;
            sourceOutMs = Math.min(total, cursor + durationMs);
            assetCursor[line.slot] = sourceOutMs;
          }

          const audioCreate: ClipCreate = {
            track_id: audioTrack.id,
            project_id: project.id,
            asset_id: assetId,
            start_time_ms: absStart,
            duration_ms: Math.max(100, sourceOutMs - sourceInMs),
            source_in_ms: sourceInMs,
            source_out_ms: sourceOutMs,
          };
          const audioClip = await window.snipette.timeline.addClip(audioTrack.id, audioCreate);
          addClipLocal(audioClip);
          createdAudioCount++;
        } catch (err) {
          errors.push(`${line.speaker}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      useTimelineStore.getState().computeDuration();
      const parts: string[] = [
        `${createdTextCount} text${createdTextCount === 1 ? '' : 's'}`,
      ];
      if (createdAudioCount > 0) {
        parts.push(`${createdAudioCount} audio clip${createdAudioCount === 1 ? '' : 's'}`);
      }
      pushToast({
        kind: errors.length > 0 ? 'info' : 'success',
        message:
          errors.length > 0
            ? `Placed ${parts.join(' + ')}, with ${errors.length} skip${errors.length === 1 ? '' : 's'}: ${errors[0]}`
            : `Placed ${parts.join(' + ')}`,
      });
      setScript('');
      close();
    } catch (err) {
      pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to place dialogue.',
      });
    } finally {
      setBusy(false);
    }
  };

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
              width: 'min(760px, 100%)',
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
            <Header onClose={close} />

            <div style={{ padding: '18px 24px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Field
                label="Script"
                hint={`Format each line as "Speaker: line". First 4 unique speakers get distinct styles; extras round-robin.`}
              >
                <textarea
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  placeholder={PLACEHOLDER}
                  rows={8}
                  spellCheck
                  style={{
                    width: '100%',
                    fontFamily: 'var(--font-mono, ui-monospace)',
                    fontSize: 12.5,
                    lineHeight: 1.55,
                    padding: '10px 12px',
                    background: 'var(--bg-base)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                    color: 'var(--text-primary)',
                    resize: 'vertical',
                  }}
                />
              </Field>

              <SpeakerVoiceRow
                speakers={speakers}
                ttsVoices={ttsVoices}
                audioAssets={audioAssets}
                voiceConfig={voiceConfig}
                onChange={setVoiceConfig}
              />

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <Field label={`Speed · ${msPerChar} ms/char`} hint="Typewriter pace per character.">
                  <Slider value={msPerChar} min={30} max={150} step={5} onChange={(v) => setMsPerChar(Math.round(v))} />
                </Field>
                <Field label={`Min line · ${(minMs / 1000).toFixed(1)} s`} hint="Floor for short lines.">
                  <Slider value={minMs} min={600} max={4000} step={50} onChange={(v) => setMinMs(Math.round(v))} />
                </Field>
                <Field label={`Gap · ${gapMs} ms`} hint="Pause between lines.">
                  <Slider value={gapMs} min={0} max={1500} step={20} onChange={(v) => setGapMs(Math.round(v))} />
                </Field>
              </div>

              <Preview lines={lines} speakers={speakers} durations={durations} totalDuration={totalDuration} />

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="sn-btn-ghost" onClick={close} disabled={busy}>
                  Cancel
                </button>
                <button
                  className="sn-btn-primary"
                  onClick={() => void place()}
                  disabled={busy || lines.length === 0 || !project}
                >
                  {busy ? 'Placing…' : `Place ${lines.length} line${lines.length === 1 ? '' : 's'} at playhead`}
                </button>
              </div>
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
          background: 'rgba(200,242,58,0.12)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--accent-primary)',
        }}
      >
        <Icons.TextT size={18} />
      </div>
      <div style={{ flex: 1 }}>
        <div className="display" style={{ fontSize: 20, letterSpacing: '0.06em' }}>DIALOGUE</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          Type a script · auto-styled chat bubbles dropped on the text track.
        </div>
      </div>
      <button className="sn-icon-btn" onClick={onClose} aria-label="Close">
        <Icons.X size={14} />
      </button>
    </div>
  );
}

function SpeakerVoiceRow({
  speakers,
  ttsVoices,
  audioAssets,
  voiceConfig,
  onChange,
}: {
  speakers: DialogueSpeaker[];
  ttsVoices: TtsVoice[];
  audioAssets: MediaAsset[];
  voiceConfig: Record<number, SpeakerVoiceConfig>;
  onChange: (next: Record<number, SpeakerVoiceConfig>) => void;
}) {
  if (speakers.length === 0) return null;
  const update = (slot: number, patch: Partial<SpeakerVoiceConfig>): void => {
    const current = voiceConfig[slot] ?? { mode: 'none' };
    onChange({ ...voiceConfig, [slot]: { ...current, ...patch } });
  };
  const ttsSupported = ttsVoices.length > 0;
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-secondary)', marginBottom: 6 }}>
        Detected speakers {speakers.length > 4 && '(slots 1–4 round-robin)'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {speakers.map((s) => {
          const cfg = voiceConfig[s.slot] ?? { mode: 'none' as const };
          return (
            <div
              key={`${s.name}-${s.slot}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 8,
                background: 'var(--bg-base)',
                border: `1px solid ${s.accent}40`,
                fontSize: 11,
                color: 'var(--text-primary)',
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: s.accent,
                  boxShadow: `0 0 6px ${s.accent}`,
                }}
              />
              <span style={{ fontWeight: 700, minWidth: 80 }}>{s.name}</span>
              <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{s.isLeft ? 'L' : 'R'}</span>
              <div style={{ flex: 1 }} />
              <select
                value={cfg.mode}
                onChange={(e) => update(s.slot, { mode: e.target.value as SpeakerVoiceMode })}
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 6,
                  padding: '5px 8px',
                  fontSize: 11,
                  color: 'var(--text-primary)',
                }}
              >
                <option value="none">Text only</option>
                <option value="tts" disabled={!ttsSupported}>
                  TTS {!ttsSupported ? '(macOS only)' : ''}
                </option>
                <option value="asset" disabled={audioAssets.length === 0}>
                  From library {audioAssets.length === 0 ? '(no audio)' : ''}
                </option>
              </select>
              {cfg.mode === 'tts' && (
                <select
                  value={cfg.ttsVoice ?? ttsVoices[0]?.name ?? ''}
                  onChange={(e) => update(s.slot, { ttsVoice: e.target.value })}
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 6,
                    padding: '5px 8px',
                    fontSize: 11,
                    color: 'var(--text-primary)',
                  }}
                >
                  {ttsVoices.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} · {v.locale}
                    </option>
                  ))}
                </select>
              )}
              {cfg.mode === 'asset' && (
                <select
                  value={cfg.assetId ?? ''}
                  onChange={(e) => update(s.slot, { assetId: e.target.value })}
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 6,
                    padding: '5px 8px',
                    fontSize: 11,
                    color: 'var(--text-primary)',
                    maxWidth: 220,
                  }}
                >
                  <option value="">(pick an asset)</option>
                  {audioAssets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.original_path.split(/[\\/]/).pop()} · {((a.duration_ms ?? 0) / 1000).toFixed(1)}s
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>
      {!ttsSupported && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
          Built-in TTS uses macOS's <code>say</code> command. On other platforms you can still use library-asset mode.
        </div>
      )}
    </div>
  );
}

function Preview({
  lines,
  speakers,
  durations,
  totalDuration,
}: {
  lines: ReturnType<typeof parseDialogueScript>['lines'];
  speakers: DialogueSpeaker[];
  durations: { startMs: number; durationMs: number }[];
  totalDuration: number;
}) {
  if (lines.length === 0) {
    return (
      <div
        style={{
          padding: '14px 12px',
          background: 'var(--bg-base)',
          border: '1px dashed var(--border-subtle)',
          borderRadius: 8,
          textAlign: 'center',
          fontSize: 11.5,
          color: 'var(--text-muted)',
        }}
      >
        Start typing your script above to see a preview.
      </div>
    );
  }
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-secondary)', marginBottom: 8 }}>
        Preview · {lines.length} line{lines.length === 1 ? '' : 's'} · {(totalDuration / 1000).toFixed(1)}s total
      </div>
      <div
        style={{
          maxHeight: 220,
          overflowY: 'auto',
          background: 'var(--bg-base)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 8,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {lines.map((line, i) => {
          const meta = speakers.find((s) => s.slot === line.slot);
          const accent = meta?.accent ?? '#888';
          const isLeft = meta?.isLeft ?? true;
          const dur = durations[i];
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: isLeft ? 'flex-start' : 'flex-end',
              }}
            >
              <div
                style={{
                  maxWidth: '78%',
                  padding: '8px 12px',
                  borderRadius: 12,
                  background: accent,
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 600,
                  lineHeight: 1.35,
                  position: 'relative',
                }}
              >
                <div style={{ fontSize: 9, opacity: 0.8, marginBottom: 2 }}>
                  {line.speaker} · {(dur.startMs / 1000).toFixed(1)}s → {((dur.startMs + dur.durationMs) / 1000).toFixed(1)}s
                </div>
                {line.text}
              </div>
            </div>
          );
        })}
      </div>
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
          letterSpacing: 0.08,
          color: 'var(--text-secondary)',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      {children}
      {hint && (
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>{hint}</div>
      )}
    </div>
  );
}
