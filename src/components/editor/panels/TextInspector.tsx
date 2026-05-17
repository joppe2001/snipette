import React, { useCallback, useMemo, useState } from 'react';
import { useTimelineStore } from '@/store/timeline.store';
import { useProjectStore } from '@/store/project.store';
import { useEditorStore } from '@/store/editor.store';
import { InspectorSection, Field, FieldRow } from '../RightPanel';
import { Slider } from '@/components/ui/Slider';
import { Toggle } from '@/components/ui/Toggle';
import { NumInput } from '@/components/ui/Input';
import { FontPicker } from '@/components/ui/FontPicker';
import { Icons } from '@/components/ui/icons';
import { ColorPicker } from '@/components/ui/ColorPicker';
import { normalizeHex } from '@/utils/color-conversions';
import {
  parseTextAnimation,
  splitWordsEvenly,
  type TextAnimationSpec,
  type TextAnimIn,
  type TextAnimLoop,
  type TextAnimOut,
} from '@/utils/text-animation';
import {
  COMPOUND_TEMPLATES,
  KARAOKE_STYLE,
  KARAOKE_ANIMATION,
  TEXT_TEMPLATES,
  textStyleToCss,
  type CompoundTemplate,
  type TextStyleFull,
} from '@/utils/text-templates';
import { SN_TEXT_DESIGN_MIME, type TextDesignDragPayload } from '@/utils/text-design-drag';
import {
  HOOK_CATEGORY_LABELS,
  groupHooksByCategory,
  type HookCategory,
  type HookTemplate,
} from '@/utils/hook-templates';
import { DEFAULT_TEXT_ANIM } from '@/utils/text-animation';
import type { Clip, TextStyle } from '@shared/types';

const DEFAULT_STYLE: TextStyle = {
  font_family: 'Barlow Condensed',
  font_size: 64,
  font_weight: 800,
  color: '#FFFFFF',
  align: 'center',
  line_height: 1,
  letter_spacing: 0.02,
  stroke_color: '#0A0A0C',
  stroke_width: 2,
  bg_enabled: false,
  bg_color: '#0A0A0C',
  bg_padding: 8,
  bg_radius: 4,
};

/** Default style applied to a fresh draft clip when the user opens the text
 *  tool without a selection. Slightly bigger than DEFAULT_STYLE so the preview
 *  is legible right away. */
const DRAFT_DEFAULT_STYLE: TextStyleFull = {
  font_family: 'Barlow Condensed',
  font_size: 80,
  font_weight: 900,
  color: '#FFFFFF',
  align: 'center',
  line_height: 1.05,
  letter_spacing: 0.02,
  stroke_color: '#0A0A0C',
  stroke_width: 2,
  bg_enabled: false,
  bg_color: '#0A0A0C',
  bg_padding: 8,
  bg_radius: 4,
};

const DRAFT_DEFAULT_ANIM: TextAnimationSpec = {
  ...DEFAULT_TEXT_ANIM,
  in_preset: 'Pop',
  in_ms: 280,
};

/** A minimal Clip-shaped record used to back the inspector when no real clip
 *  is selected. Only the fields the inspector reads are populated; the rest
 *  are left absent so callers that accidentally peek crash loudly. */
interface DraftClip {
  text_content: string;
  text_style_json: string;
  text_animation_json: string;
  duration_ms: number;
  position_y: number;
}

const DRAFT_DEFAULT: DraftClip = {
  text_content: 'Your text',
  text_style_json: JSON.stringify(DRAFT_DEFAULT_STYLE),
  text_animation_json: JSON.stringify(DRAFT_DEFAULT_ANIM),
  duration_ms: 2500,
  position_y: 0,
};

function parseStyle(json: string | null): TextStyle {
  if (!json) return DEFAULT_STYLE;
  try {
    return { ...DEFAULT_STYLE, ...JSON.parse(json) };
  } catch {
    return DEFAULT_STYLE;
  }
}

const IN_PRESETS: TextAnimIn[] = [
  'None',
  'Fade',
  'Pop',
  'Bounce',
  'Slam',
  'Slide ↑',
  'Slide ↓',
  'Slide ←',
  'Slide →',
  'Zoom',
  'Rise',
  'Spin',
  'Glitch',
  'Typewriter',
  'LetterWave',
];

/** Karaoke mode labels for the karaoke_mode picker in the Animation section. */
const KARAOKE_MODES: { id: 'highlight' | 'reveal' | 'bounce' | 'glow' | 'pop-each'; label: string }[] = [
  { id: 'highlight', label: 'Highlight' },
  { id: 'reveal', label: 'Reveal' },
  { id: 'bounce', label: 'Bounce' },
  { id: 'glow', label: 'Glow' },
  { id: 'pop-each', label: 'Pop' },
];
const LOOP_PRESETS: TextAnimLoop[] = [
  'None',
  'Pulse',
  'Float',
  'Shake',
  'Wave',
  'Breathe',
  'Jitter',
  'Spin',
  'Karaoke',
];
const OUT_PRESETS: TextAnimOut[] = ['None', 'Fade', 'Shrink', 'Dissolve', 'Slide ↑', 'Slide ↓', 'Slide ←', 'Slide →'];

export function TextInspector({ clip }: { clip: Clip | null }): JSX.Element {
  const updateLocal = useTimelineStore((s) => s.updateClipLocal);
  const replaceClip = useTimelineStore((s) => s.replaceClip);
  const addClipLocal = useTimelineStore((s) => s.addClip);
  const tracks = useTimelineStore((s) => s.tracks);
  const playheadMs = useTimelineStore((s) => s.playheadMs);
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const computeDuration = useTimelineStore((s) => s.computeDuration);
  const assets = useProjectStore((s) => s.assets);
  const project = useProjectStore((s) => s.activeProject);
  const pushToast = useEditorStore((s) => s.pushToast);
  const [captionBusy, setCaptionBusy] = useState(false);
  const [captionProgress, setCaptionProgress] = useState(0);

  // Draft-clip state used when the inspector is opened without a selection
  // (Text tool active, nothing selected). All edits flow into this local state
  // until the user drags the preview tile onto the canvas / timeline to place
  // a real clip.
  const [draft, setDraft] = useState<DraftClip>(DRAFT_DEFAULT);

  const isDraft = clip === null;
  /** Single source of truth the inspector renders from — real clip when one is
   *  selected, otherwise the in-memory draft. Both expose the same shape for
   *  the small subset of fields the inspector reads. */
  const clipOrDraft = isDraft ? draft : clip;

  const [content, setContent] = useState<string>(clipOrDraft.text_content ?? '');
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const style = parseStyle(clipOrDraft.text_style_json);
  const animation = parseTextAnimation(clipOrDraft.text_animation_json);
  // Compound clips carry their subtitle text + style on the animation spec, so
  // the inspector can show two text fields (Title + Subtitle) instead of one.
  const isCompound = animation.subtitle_text !== undefined;
  const [subtitleDraft, setSubtitleDraft] = useState<string>(animation.subtitle_text ?? '');
  // Re-sync local subtitle text when the selected clip changes — same pattern
  // the regular content field relies on (it keys off `content` initial state).
  const clipId = clip?.id ?? '__draft__';
  const lastClipIdRef = React.useRef<string>(clipId);
  if (lastClipIdRef.current !== clipId) {
    lastClipIdRef.current = clipId;
    setSubtitleDraft(animation.subtitle_text ?? '');
    setContent(clipOrDraft.text_content ?? '');
  }
  const subtitleStyle = useMemo<TextStyleFull>(() => {
    const raw = animation.subtitle_style_json;
    if (!raw) {
      // Fall back to the title's style so the inputs always show valid values
      // even on partially-migrated clips.
      return style as TextStyleFull;
    }
    try {
      return { ...(style as TextStyleFull), ...JSON.parse(raw) };
    } catch {
      return style as TextStyleFull;
    }
  }, [animation.subtitle_style_json, style]);

  /**
   * Apply a partial update. In real-clip mode this writes through to the
   * timeline store + backend; in draft mode it only mutates the local draft
   * state. Callers pass the same Partial<Clip> shape in both cases.
   */
  const commit = useCallback(
    async (updates: Partial<Clip>) => {
      if (isDraft) {
        setDraft((prev) => {
          const next: DraftClip = { ...prev };
          if (updates.text_content !== undefined) next.text_content = updates.text_content ?? '';
          if (updates.text_style_json !== undefined && updates.text_style_json !== null) {
            next.text_style_json = updates.text_style_json;
          }
          if (updates.text_animation_json !== undefined && updates.text_animation_json !== null) {
            next.text_animation_json = updates.text_animation_json;
          }
          if (updates.duration_ms !== undefined) next.duration_ms = updates.duration_ms;
          if (updates.position_y !== undefined) next.position_y = updates.position_y;
          return next;
        });
        return;
      }
      // Real clip path.
      updateLocal(clip!.id, updates);
      try {
        const updated = await window.snipette.timeline.updateClip(clip!.id, updates);
        replaceClip(updated);
      } catch {
        // ignore
      }
    },
    [isDraft, clip, updateLocal, replaceClip],
  );

  // Push a freshly-picked color to the front of the recent list, dedupe, cap at 6.
  const pushRecent = useCallback((hex: string) => {
    const normalized = normalizeHex(hex);
    if (!normalized) return;
    setRecentColors((prev) => {
      const next = [normalized, ...prev.filter((c) => c !== normalized)];
      return next.slice(0, 6);
    });
  }, []);

  const commitColor = useCallback(
    (key: keyof TextStyle, hex: string) => {
      pushRecent(hex);
      const merged = { ...style, [key]: hex } as TextStyle;
      commit({ text_style_json: JSON.stringify(merged) });
    },
    // commit/style are recomputed every render, so the dependency list intentionally
    // omits them — pushRecent is the only stable dep needed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pushRecent, style],
  );

  const commitStyle = (next: Partial<TextStyle>) => {
    const merged = { ...style, ...next };
    commit({ text_style_json: JSON.stringify(merged) });
  };

  const commitAnim = (next: Partial<typeof animation>) => {
    commit({ text_animation_json: JSON.stringify({ ...animation, ...next }) });
  };

  /**
   * Update the subtitle row's independent style. We persist the full subtitle
   * style as a JSON blob on `animation.subtitle_style_json`, so the title's
   * `text_style_json` is untouched and each row owns its own look.
   */
  const commitSubtitleStyle = (next: Partial<TextStyleFull>) => {
    const merged: TextStyleFull = { ...subtitleStyle, ...next };
    commitAnim({ subtitle_style_json: JSON.stringify(merged) });
  };

  // Apply a hook overlay. In real-clip mode we overwrite the current clip's
  // text + style + animation + position so clicking a tile transforms the
  // selected clip rather than spawning a duplicate. In draft mode the same
  // overwrite happens on the draft state — the user can then drag to place.
  const dropHook = useCallback(
    async (hook: HookTemplate) => {
      if (!isDraft) pushHistory();
      const mergedAnim = { ...DEFAULT_TEXT_ANIM, ...hook.animation };
      setContent(hook.text);
      await commit({
        text_content: hook.text,
        text_style_json: JSON.stringify(hook.style),
        text_animation_json: JSON.stringify(mergedAnim),
        position_y: hook.positionYOffset,
      });
      pushToast({ kind: 'success', message: `${hook.name} applied` });
    },
    [isDraft, commit, pushHistory, pushToast],
  );

  /**
   * Transcribe the project's speech asset with word-level timestamps and create a
   * sequence of karaoke caption clips — one per Whisper segment, with the segment's
   * word timings stored on the clip's text_animation_json. If Whisper didn't emit
   * token-level timings (older builds), we fall back to splitting the segment text
   * evenly across its duration so the highlight still moves.
   */
  const generateKaraoke = async () => {
    if (!project) return;
    const whisperAvailable = await window.snipette.system.whisperAvailable();
    if (!whisperAvailable) {
      pushToast({
        kind: 'error',
        message:
          'Whisper not installed. Place a whisper.cpp binary at resources/whisper and ggml-base.en.bin alongside it, then restart Snipette.',
      });
      return;
    }
    const speechAsset =
      assets.find((a) => a.type === 'audio') ?? assets.find((a) => a.type === 'video');
    if (!speechAsset) {
      pushToast({ kind: 'info', message: 'Import an audio or video file first.' });
      return;
    }
    const captionsTrack = tracks.find((t) => t.type === 'text');
    if (!captionsTrack) {
      pushToast({ kind: 'error', message: 'No captions track on this project.' });
      return;
    }
    setCaptionBusy(true);
    setCaptionProgress(0);
    const offProgress = window.snipette.captions.onProgress((p) =>
      setCaptionProgress(p.percent),
    );
    try {
      const segments = await window.snipette.captions.transcribe(speechAsset.id);
      pushHistory();
      let withRealWords = 0;
      for (const seg of segments) {
        const segDuration = Math.max(300, seg.endMs - seg.startMs);
        // Whisper may emit absolute timestamps for words; we store them relative to
        // the clip's start so the renderer doesn't need to know the segment origin.
        const wordTimings = (() => {
          if (seg.words && seg.words.length > 0) {
            withRealWords += 1;
            return seg.words.map((w) => ({
              word: w.text,
              startMs: Math.max(0, w.startMs - seg.startMs),
              endMs: Math.max(0, w.endMs - seg.startMs),
            }));
          }
          return splitWordsEvenly(seg.text, 0, segDuration);
        })();
        const created = await window.snipette.timeline.addClip(captionsTrack.id, {
          track_id: captionsTrack.id,
          project_id: project.id,
          start_time_ms: seg.startMs,
          duration_ms: segDuration,
          source_in_ms: 0,
          source_out_ms: segDuration,
          text_content: seg.text,
          text_style_json: JSON.stringify(KARAOKE_STYLE),
        });
        // ClipCreate doesn't carry text_animation_json — apply it via update so
        // the new clip has both the Karaoke loop preset and its per-word timings.
        const animSpec = { ...KARAOKE_ANIMATION, word_timings: wordTimings };
        const positioned = await window.snipette.timeline.updateClip(created.id, {
          text_animation_json: JSON.stringify(animSpec),
        });
        addClipLocal(positioned);
      }
      const suffix = withRealWords === segments.length
        ? ''
        : ' (synthetic word timings — Whisper build did not provide tokens)';
      pushToast({
        kind: 'success',
        message: `Added ${segments.length} karaoke caption clips${suffix}.`,
      });
    } catch (e) {
      pushToast({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Karaoke caption generation failed.',
      });
    } finally {
      offProgress();
      setCaptionBusy(false);
      setCaptionProgress(0);
      computeDuration();
    }
  };

  /**
   * Drop a compound template (e.g. Block-Reveal title + subtitle). Spawns ONE
   * text clip on the current text track at the playhead — `text_content`
   * holds the title, `animation.subtitle_text` holds the subtitle, and the
   * renderer paints both rows stacked. This replaces the old two-clip flow
   * where overlapping overlays made the subtitle uneditable.
   *
   * Only available in real-clip mode: compound spawns a concrete clip so it
   * needs a track context. In draft mode we hint the user to place first.
   */
  const dropCompound = useCallback(
    async (tpl: CompoundTemplate) => {
      if (isDraft) {
        pushToast({
          kind: 'info',
          message: 'Drag the preview onto a track first, then apply a compound template.',
        });
        return;
      }
      if (!project) return;
      // Find an existing text track preferring the one the selected clip lives
      // on, then any text track. If none exists, create one so the compound
      // template "just works" without forcing the user to add a text clip first.
      let targetTrack =
        tracks.find((t) => t.id === clip!.track_id && t.type === 'text') ??
        tracks.find((t) => t.type === 'text');
      pushHistory();
      if (!targetTrack) {
        try {
          targetTrack = await window.snipette.timeline.addTrack({
            project_id: project.id,
            type: 'text',
            order_index: tracks.length,
            name: 'Text',
          });
          useTimelineStore.getState().upsertTrack(targetTrack);
        } catch {
          pushToast({ kind: 'error', message: 'Failed to add text track.' });
          return;
        }
      }
      try {
        const sub = tpl.clip;
        const created = await window.snipette.timeline.addClip(targetTrack.id, {
          track_id: targetTrack.id,
          project_id: project.id,
          start_time_ms: Math.max(0, playheadMs),
          duration_ms: sub.durationMs,
          source_in_ms: 0,
          source_out_ms: sub.durationMs,
          text_content: sub.titleText,
          text_style_json: JSON.stringify(sub.titleStyle),
        });
        const mergedAnim: TextAnimationSpec = {
          ...DEFAULT_TEXT_ANIM,
          ...sub.animation,
          // Force title role — single-clip compound is always "title" for the
          // animation branch; the subtitle is identified by `subtitle_text`.
          compound_role: 'title',
          subtitle_text: sub.subtitleText,
          subtitle_style_json: JSON.stringify(sub.subtitleStyle),
        };
        const positioned = await window.snipette.timeline.updateClip(created.id, {
          position_y: sub.positionY,
          text_animation_json: JSON.stringify(mergedAnim),
        });
        addClipLocal(positioned);
        computeDuration();
        pushToast({ kind: 'success', message: `${tpl.name} added` });
      } catch (e) {
        pushToast({
          kind: 'error',
          message: e instanceof Error ? e.message : 'Could not drop template.',
        });
      }
    },
    [
      isDraft,
      project,
      tracks,
      clip,
      playheadMs,
      pushHistory,
      addClipLocal,
      computeDuration,
      pushToast,
    ],
  );

  const hookGroups = useMemo(() => groupHooksByCategory(), []);

  // Drag the live preview tile to place this clip elsewhere on the canvas /
  // timeline. Uses the shared MIME the PreviewCanvas + TrackRow drop handlers
  // listen for — they create a NEW clip with the configured content + style +
  // animation at the drop location.
  const onPreviewDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    const payload: TextDesignDragPayload = {
      text: clipOrDraft.text_content ?? content ?? 'Text',
      style: style as TextStyleFull,
      animation,
      durationMs: clipOrDraft.duration_ms,
    };
    e.dataTransfer.setData(SN_TEXT_DESIGN_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div>
      {/* Sticky preview tile — pinned to the top of the inspector's scroll
          viewport so it stays visible while the user scrolls through every
          edit section below. Rendered outside InspectorSection because the
          collapsible chrome would defeat the always-visible intent. */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 5,
          padding: '10px 14px 10px',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-subtle)',
          boxShadow: '0 6px 12px rgba(0,0,0,0.25)',
        }}
      >
        <div className="sn-section-label" style={{ marginBottom: 6 }}>Preview</div>
        <div
          draggable
          onDragStart={onPreviewDragStart}
          title="Drag to canvas/timeline to add a text clip with these styles"
          style={{
            position: 'relative',
            width: '100%',
            minHeight: 110,
            borderRadius: 8,
            border: '1px solid var(--border-subtle)',
            background:
              'repeating-conic-gradient(rgba(255,255,255,0.04) 0 25%, transparent 0 50%) 0 0 / 14px 14px, var(--bg-base)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 12,
            overflow: 'hidden',
            cursor: 'grab',
            userSelect: 'none',
          }}
          onMouseDown={(e) => {
            (e.currentTarget as HTMLDivElement).style.cursor = 'grabbing';
          }}
          onMouseUp={(e) => {
            (e.currentTarget as HTMLDivElement).style.cursor = 'grab';
          }}
        >
          <div
            style={{
              ...textStyleToCss({
                ...(style as TextStyleFull),
                // Clamp decorations so the THUMBNAIL stays legible. A clip
                // designed at 200 px font with a 60 px glow looks like a colored
                // blur at the tile's effective ~14 px font size. The on-canvas
                // styling is unaffected — only this preview rendering uses the
                // clamps.
                stroke_width: Math.min(
                  ((style as TextStyleFull).stroke_width ?? 0) * 0.25,
                  2,
                ),
                glow_size: (style as TextStyleFull).glow_enabled
                  ? Math.min((style as TextStyleFull).glow_size ?? 6, 6)
                  : (style as TextStyleFull).glow_size,
                shadow_blur: (style as TextStyleFull).shadow_enabled
                  ? Math.min((style as TextStyleFull).shadow_blur ?? 6, 6)
                  : (style as TextStyleFull).shadow_blur,
                extrude_depth: (style as TextStyleFull).extrude_enabled
                  ? Math.min((style as TextStyleFull).extrude_depth ?? 3, 3)
                  : (style as TextStyleFull).extrude_depth,
                bg_padding: (style as TextStyleFull).bg_enabled
                  ? Math.min((style as TextStyleFull).bg_padding ?? 4, 6)
                  : (style as TextStyleFull).bg_padding,
                bg_radius: (style as TextStyleFull).bg_enabled
                  ? Math.min((style as TextStyleFull).bg_radius ?? 4, 12)
                  : (style as TextStyleFull).bg_radius,
                letter_spacing: Math.min(
                  (style as TextStyleFull).letter_spacing ?? 0,
                  0.06,
                ),
              }),
              // Scale the tile-rendered text down so a 200px font fits in the
              // preview without overflowing — keeps proportions, lets the user
              // see the actual style decisions.
              fontSize: (() => {
                const s = (style as TextStyleFull).font_size ?? 64;
                return `${Math.max(10, Math.min(28, s * 0.22))}px`;
              })(),
              textAlign: 'center',
              maxWidth: '100%',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
              pointerEvents: 'none',
            }}
          >
            {clipOrDraft.text_content || content || 'Text'}
          </div>
          {isDraft && (
            <div
              style={{
                position: 'absolute',
                bottom: 4,
                right: 6,
                fontSize: 8.5,
                color: 'var(--text-muted)',
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                fontWeight: 600,
                pointerEvents: 'none',
              }}
            >
              Drag to place
            </div>
          )}
        </div>
        <div style={{ fontSize: 9.5, color: 'var(--text-muted)', marginTop: 6, textAlign: 'right' }}>
          Drag tile → canvas / timeline
        </div>
      </div>

      <InspectorSection title="Hooks">
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
          {isDraft
            ? 'Click to load a viral-hook style into the draft, then drag the preview to place.'
            : 'Click to drop a viral-hook overlay at the playhead — full style, animation, and position baked in.'}
        </div>
        {(Object.keys(hookGroups) as HookCategory[]).map((cat) => {
          const items = hookGroups[cat];
          if (items.length === 0) return null;
          return (
            <div key={cat} style={{ marginBottom: 10 }}>
              <div className="sn-section-label" style={{ marginBottom: 6, fontSize: 9 }}>
                {HOOK_CATEGORY_LABELS[cat]}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                {items.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => dropHook(h)}
                    title={`Apply "${h.name}"`}
                    style={{
                      aspectRatio: '5/3',
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 6,
                      padding: 8,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                      overflow: 'hidden',
                      transition: 'border-color .12s',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#2a2a3a')}
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.borderColor = 'var(--border-subtle)')
                    }
                  >
                    <span
                      style={{
                        ...textStyleToCss({
                          ...h.style,
                          font_size: Math.min(18, (h.style.font_size ?? 14) / 6) || 12,
                          bg_padding: h.style.bg_enabled ? 4 : 0,
                          bg_radius: h.style.bg_enabled
                            ? Math.min(8, h.style.bg_radius / 2)
                            : 0,
                          // Tone down expensive effects in the small preview.
                          extrude_depth: h.style.extrude_enabled
                            ? Math.min(2, h.style.extrude_depth ?? 2)
                            : undefined,
                          glow_size: h.style.glow_enabled
                            ? Math.min(5, h.style.glow_size ?? 5)
                            : undefined,
                          shadow_blur: h.style.shadow_enabled
                            ? Math.min(5, h.style.shadow_blur ?? 0)
                            : undefined,
                        }),
                        whiteSpace: 'nowrap',
                        maxWidth: '95%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {h.text.split('\n')[0]}
                    </span>
                    <span
                      style={{
                        fontSize: 8.5,
                        color: 'var(--text-muted)',
                        letterSpacing: 0.4,
                        textTransform: 'uppercase',
                        fontWeight: 600,
                      }}
                    >
                      {h.emoji ? `${h.emoji} ` : ''}
                      {h.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </InspectorSection>

      <InspectorSection title="Templates">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
          {TEXT_TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                const updates: Partial<Clip> = {
                  text_style_json: JSON.stringify(t.style),
                };
                if (t.animation) {
                  const merged = { ...animation, ...t.animation };
                  updates.text_animation_json = JSON.stringify(merged);
                }
                commit(updates);
              }}
              title={`Apply "${t.name}"`}
              style={{
                aspectRatio: '4/3',
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 6,
                padding: 6,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                overflow: 'hidden',
                transition: 'border-color .12s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#2a2a3a')}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
            >
              <span
                style={{
                  ...textStyleToCss({
                    ...(t.style as TextStyleFull),
                    font_size: Math.min(22, (t.style.font_size ?? 14) / 5) || 14,
                    bg_padding: t.style.bg_enabled ? 4 : 0,
                    bg_radius: t.style.bg_enabled ? Math.min(8, t.style.bg_radius / 2) : 0,
                    // Tone down extrude/glow on the small preview card so neighbours don't overlap.
                    extrude_depth: t.style.extrude_enabled ? Math.min(3, t.style.extrude_depth ?? 3) : undefined,
                    glow_size: t.style.glow_enabled ? Math.min(6, t.style.glow_size ?? 6) : undefined,
                    shadow_blur: t.style.shadow_enabled ? Math.min(6, t.style.shadow_blur ?? 0) : undefined,
                  }),
                  whiteSpace: 'nowrap',
                  maxWidth: '95%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {t.defaultText}
              </span>
              <span style={{ fontSize: 8.5, color: 'var(--text-muted)', letterSpacing: 0.4, textTransform: 'uppercase', fontWeight: 600 }}>
                {t.name}
              </span>
            </button>
          ))}
        </div>
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)' }}>
          Applies the full style + animation. Your text content is preserved.
        </div>
      </InspectorSection>

      <InspectorSection title="Compound">
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
          {isDraft
            ? 'Compound templates spawn two coordinated clips. Drop the draft on a track first, then apply.'
            : 'Spawns two coordinated text clips on the current track. Drop, then edit each clip\'s text in place.'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
          {COMPOUND_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              onClick={() => void dropCompound(tpl)}
              title={isDraft ? 'Drop the draft on a track first' : `Drop "${tpl.name}" at the playhead`}
              disabled={isDraft}
              style={{
                aspectRatio: '5/3',
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 6,
                padding: 8,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                overflow: 'hidden',
                transition: 'border-color .12s, opacity .12s',
                opacity: isDraft ? 0.5 : 1,
                cursor: isDraft ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={(e) => {
                if (!isDraft) e.currentTarget.style.borderColor = '#2a2a3a';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
            >
              <span
                style={{
                  // Tiny inline preview: title above a coloured block strip.
                  display: 'inline-flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 2,
                }}
              >
                <span
                  style={{
                    fontFamily: 'Barlow Condensed',
                    fontWeight: 900,
                    fontSize: 16,
                    color: '#fff',
                    textTransform: 'uppercase',
                    letterSpacing: 1,
                  }}
                >
                  TITLE
                </span>
                <span
                  style={{
                    width: 36,
                    height: 4,
                    background: tpl.clip.animation.block_color ?? '#C8F23A',
                    borderRadius: 1,
                  }}
                />
                <span
                  style={{
                    fontSize: 9,
                    color: 'var(--text-muted)',
                    letterSpacing: 0.4,
                  }}
                >
                  subtitle
                </span>
              </span>
              <span
                style={{
                  fontSize: 8.5,
                  color: 'var(--text-muted)',
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                  fontWeight: 600,
                }}
              >
                {tpl.name}
              </span>
            </button>
          ))}
        </div>
      </InspectorSection>

      <InspectorSection title="Text" defaultOpen>
        <Field label={isCompound ? 'Title' : 'Content'}>
          <textarea
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              // In real-clip mode mirror the change through the local store so
              // the canvas updates per keystroke (the backend commit happens on
              // blur). In draft mode the draft state IS the source of truth so
              // we update it directly here for live-typing feedback.
              if (isDraft) {
                setDraft((prev) => ({ ...prev, text_content: e.target.value }));
              } else {
                updateLocal(clip!.id, { text_content: e.target.value });
              }
            }}
            onBlur={() => commit({ text_content: content })}
            style={{
              background: 'var(--bg-base)',
              borderRadius: 6,
              padding: '8px 10px',
              border: '1px solid var(--border-subtle)',
              fontSize: 12,
              color: 'var(--text-primary)',
              minHeight: 56,
              width: '100%',
              resize: 'vertical',
            }}
          />
        </Field>
        {isCompound && (
          <>
            <Field label="Subtitle">
              <textarea
                value={subtitleDraft}
                onChange={(e) => {
                  setSubtitleDraft(e.target.value);
                  // Live-update so the preview reflects each keystroke. In real
                  // clip mode we mirror through updateLocal; in draft mode the
                  // draft state IS the source of truth.
                  if (isDraft) {
                    const nextAnim = { ...animation, subtitle_text: e.target.value };
                    setDraft((prev) => ({
                      ...prev,
                      text_animation_json: JSON.stringify(nextAnim),
                    }));
                  } else {
                    const nextAnim = { ...animation, subtitle_text: e.target.value };
                    updateLocal(clip!.id, {
                      text_animation_json: JSON.stringify(nextAnim),
                    });
                  }
                }}
                onBlur={() => commitAnim({ subtitle_text: subtitleDraft })}
                style={{
                  background: 'var(--bg-base)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 12,
                  color: 'var(--text-primary)',
                  minHeight: 36,
                  width: '100%',
                  resize: 'vertical',
                }}
              />
            </Field>
            <div style={{ marginTop: 6, marginBottom: 6 }}>
              <div className="sn-section-label" style={{ marginBottom: 6, fontSize: 9 }}>
                Subtitle style
              </div>
              <FieldRow>
                <Field label="Size">
                  <NumInput
                    value={subtitleStyle.font_size}
                    onChange={(v) => commitSubtitleStyle({ font_size: v })}
                  />
                </Field>
                <Field label="Weight">
                  <NumInput
                    value={subtitleStyle.font_weight}
                    onChange={(v) => commitSubtitleStyle({ font_weight: v })}
                  />
                </Field>
                <Field label="Color">
                  <ColorPicker
                    color={subtitleStyle.color}
                    onChange={(c) => {
                      pushRecent(c);
                      commitSubtitleStyle({ color: c });
                    }}
                    recent={recentColors}
                    onPickRecent={pushRecent}
                  />
                </Field>
              </FieldRow>
            </div>
          </>
        )}
        <FieldRow>
          <Field label="Font" flex={2}>
            <FontPicker value={style.font_family} onChange={(f) => commitStyle({ font_family: f })} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Size"><NumInput value={style.font_size} onChange={(v) => commitStyle({ font_size: v })} /></Field>
          <Field label="Line"><NumInput value={style.line_height} onChange={(v) => commitStyle({ line_height: v })} /></Field>
          <Field label="Spacing"><NumInput value={style.letter_spacing} onChange={(v) => commitStyle({ letter_spacing: v })} /></Field>
        </FieldRow>
        {isDraft && (
          <FieldRow>
            <Field label={`Default duration · ${(clipOrDraft.duration_ms / 1000).toFixed(1)}s`}>
              <Slider
                value={clipOrDraft.duration_ms}
                min={500}
                max={8000}
                step={100}
                onChange={(v) => commit({ duration_ms: Math.round(v) })}
                propertyName="Duration"
                defaultValue={2500}
              />
            </Field>
          </FieldRow>
        )}
      </InspectorSection>

      <InspectorSection title="Style" defaultOpen>
        <FieldRow>
          <Field label="Color">
            <ColorPicker
              color={style.color}
              onChange={(c) => commitColor('color', c)}
              recent={recentColors}
              onPickRecent={pushRecent}
            />
          </Field>
          <Field label="Stroke">
            <ColorPicker
              color={style.stroke_color}
              onChange={(c) => commitColor('stroke_color', c)}
              recent={recentColors}
              onPickRecent={pushRecent}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Stroke width">
            <Slider value={style.stroke_width / 10} min={0} max={1} onChange={(v) => commitStyle({ stroke_width: v * 10 })} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="BG"><Toggle on={style.bg_enabled} onChange={(on) => commitStyle({ bg_enabled: on })} /></Field>
          <Field label="Padding"><NumInput value={style.bg_padding} suffix="px" muted={!style.bg_enabled} onChange={(v) => commitStyle({ bg_padding: v })} /></Field>
          <Field label="Radius"><NumInput value={style.bg_radius} suffix="px" muted={!style.bg_enabled} onChange={(v) => commitStyle({ bg_radius: v })} /></Field>
        </FieldRow>
      </InspectorSection>

      <InspectorSection title="Effects">
        <FieldRow>
          <Field label="Shadow">
            <Toggle
              on={(style as TextStyleFull).shadow_enabled ?? false}
              onChange={(on) => commitStyle({ shadow_enabled: on } as Partial<TextStyle>)}
            />
          </Field>
          <Field label="Offset Y">
            <NumInput
              value={(style as TextStyleFull).shadow_y ?? 4}
              suffix="px"
              muted={!(style as TextStyleFull).shadow_enabled}
              onChange={(v) => commitStyle({ shadow_y: v } as Partial<TextStyle>)}
            />
          </Field>
          <Field label="Blur">
            <NumInput
              value={(style as TextStyleFull).shadow_blur ?? 0}
              suffix="px"
              muted={!(style as TextStyleFull).shadow_enabled}
              onChange={(v) => commitStyle({ shadow_blur: v } as Partial<TextStyle>)}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Shadow color">
            <ColorPicker
              color={(style as TextStyleFull).shadow_color ?? '#0A0A0C'}
              onChange={(c) => {
                pushRecent(c);
                commitStyle({ shadow_color: c } as Partial<TextStyle>);
              }}
              recent={recentColors}
              onPickRecent={pushRecent}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Glow">
            <Toggle
              on={(style as TextStyleFull).glow_enabled ?? false}
              onChange={(on) => commitStyle({ glow_enabled: on } as Partial<TextStyle>)}
            />
          </Field>
          <Field label="Size">
            <Slider
              value={Math.min(40, (style as TextStyleFull).glow_size ?? 12) / 40}
              min={0}
              max={1}
              onChange={(v) => commitStyle({ glow_size: Math.round(v * 40) } as Partial<TextStyle>)}
            />
          </Field>
          <Field label="Color">
            <ColorPicker
              color={(style as TextStyleFull).glow_color ?? '#C8F23A'}
              onChange={(c) => {
                pushRecent(c);
                commitStyle({ glow_color: c } as Partial<TextStyle>);
              }}
              recent={recentColors}
              onPickRecent={pushRecent}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Gradient fill">
            <Toggle
              on={(style as TextStyleFull).gradient_enabled ?? false}
              onChange={(on) => commitStyle({ gradient_enabled: on } as Partial<TextStyle>)}
            />
          </Field>
          <Field label="From">
            <ColorPicker
              color={(style as TextStyleFull).gradient_from ?? '#C8F23A'}
              onChange={(c) => {
                pushRecent(c);
                commitStyle({ gradient_from: c } as Partial<TextStyle>);
              }}
              recent={recentColors}
              onPickRecent={pushRecent}
            />
          </Field>
          <Field label="To">
            <ColorPicker
              color={(style as TextStyleFull).gradient_to ?? '#3AC8F2'}
              onChange={(c) => {
                pushRecent(c);
                commitStyle({ gradient_to: c } as Partial<TextStyle>);
              }}
              recent={recentColors}
              onPickRecent={pushRecent}
            />
          </Field>
        </FieldRow>
      </InspectorSection>

      <InspectorSection title="Animation" defaultOpen>
        <PresetGroup label="In">
          {IN_PRESETS.map((name) => (
            <PresetCard
              key={name}
              name={name}
              kind="in"
              selected={animation.in_preset === name}
              onClick={() => commitAnim({ in_preset: name })}
            />
          ))}
        </PresetGroup>
        {animation.in_preset !== 'Typewriter' && (
          <FieldRow>
            <Field label={`In · ${animation.in_ms} ms`}>
              <Slider
                value={animation.in_ms}
                min={50}
                max={2000}
                onChange={(v) => commitAnim({ in_ms: Math.round(v) })}
              />
            </Field>
          </FieldRow>
        )}
        {animation.in_preset === 'Typewriter' && (
          <>
            <FieldRow>
              <Field label={`Typewriter speed · ${animation.typewriter_cps} chars/sec`}>
                <Slider
                  value={animation.typewriter_cps}
                  min={2}
                  max={30}
                  step={1}
                  onChange={(v) => commitAnim({ typewriter_cps: Math.round(v) })}
                />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="Cursor">
                <Toggle
                  on={animation.typewriter_cursor === true}
                  onChange={(on) => commitAnim({ typewriter_cursor: on })}
                  ariaLabel="Blinking typewriter cursor"
                />
              </Field>
            </FieldRow>
          </>
        )}

        <PresetGroup label="Loop">
          {LOOP_PRESETS.map((name) => (
            <PresetCard
              key={name}
              name={name}
              kind="loop"
              selected={animation.loop_preset === name}
              onClick={() => commitAnim({ loop_preset: name })}
            />
          ))}
        </PresetGroup>

        {animation.loop_preset === 'Karaoke' && (
          <div style={{ marginBottom: 12 }}>
            <div className="sn-section-label" style={{ marginBottom: 6, fontSize: 9 }}>
              Karaoke Mode
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4 }}>
              {KARAOKE_MODES.map((m) => {
                const isSelected = (animation.karaoke_mode ?? 'highlight') === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => commitAnim({ karaoke_mode: m.id })}
                    title={`Karaoke ${m.label} mode`}
                    style={{
                      padding: '6px 4px',
                      fontSize: 9.5,
                      borderRadius: 4,
                      border: `1px solid ${
                        isSelected ? 'var(--accent-primary)' : 'var(--border-subtle)'
                      }`,
                      background: isSelected ? 'rgba(200,242,58,0.06)' : 'var(--bg-base)',
                      color: isSelected ? 'var(--accent-primary)' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      transition: 'border-color .12s, background .12s',
                    }}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <PresetGroup label="Out">
          {OUT_PRESETS.map((name) => (
            <PresetCard
              key={name}
              name={name}
              kind="out"
              selected={animation.out_preset === name}
              onClick={() => commitAnim({ out_preset: name })}
            />
          ))}
        </PresetGroup>
        <FieldRow>
          <Field label={`Out · ${animation.out_ms} ms`}>
            <Slider
              value={animation.out_ms}
              min={50}
              max={2000}
              onChange={(v) => commitAnim({ out_ms: Math.round(v) })}
            />
          </Field>
        </FieldRow>

        <FieldRow>
          <Field label="Fade with adjacent transition">
            <Toggle
              on={animation.fade_with_transition}
              onChange={(v) => commitAnim({ fade_with_transition: v })}
              ariaLabel="Fade with adjacent transition"
            />
          </Field>
        </FieldRow>
      </InspectorSection>

      <InspectorSection title="Captions">
        {isDraft ? (
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            Caption generation creates clips on the captions track. Available once
            you place a clip or select an existing one.
          </div>
        ) : (
          <>
            <button
              className="sn-btn-ghost"
              style={{ width: '100%', justifyContent: 'center' }}
              disabled={captionBusy}
              onClick={async () => {
                if (!project) return;
                const whisperAvailable = await window.snipette.system.whisperAvailable();
                if (!whisperAvailable) {
                  pushToast({
                    kind: 'error',
                    message: 'Whisper not installed. Place a whisper.cpp binary at resources/whisper and ggml-base.en.bin alongside it, then restart Snipette.',
                  });
                  return;
                }
                // Prefer the first audio asset; fall back to a video asset's audio track.
                const speechAsset =
                  assets.find((a) => a.type === 'audio') ?? assets.find((a) => a.type === 'video');
                if (!speechAsset) {
                  pushToast({ kind: 'info', message: 'Import an audio or video file first.' });
                  return;
                }
                const captionsTrack = tracks.find((t) => t.type === 'text');
                if (!captionsTrack) {
                  pushToast({ kind: 'error', message: 'No captions track on this project.' });
                  return;
                }
                setCaptionBusy(true);
                setCaptionProgress(0);
                const offProgress = window.snipette.captions.onProgress((p) => setCaptionProgress(p.percent));
                try {
                  const segments = await window.snipette.captions.transcribe(speechAsset.id);
                  useTimelineStore.getState().pushHistory();
                  for (const seg of segments) {
                    const created = await window.snipette.timeline.addClip(captionsTrack.id, {
                      track_id: captionsTrack.id,
                      project_id: project.id,
                      start_time_ms: seg.startMs,
                      duration_ms: Math.max(300, seg.endMs - seg.startMs),
                      source_in_ms: 0,
                      source_out_ms: Math.max(300, seg.endMs - seg.startMs),
                      text_content: seg.text,
                      text_style_json: JSON.stringify({
                        font_family: 'Barlow Condensed',
                        font_size: 64,
                        color: '#FFFFFF',
                        stroke_color: '#0A0A0C',
                        stroke_width: 2,
                      }),
                    });
                    addClipLocal(created);
                  }
                  pushToast({ kind: 'success', message: `Added ${segments.length} caption clips.` });
                } catch (e) {
                  pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Caption generation failed.' });
                } finally {
                  offProgress();
                  setCaptionBusy(false);
                  setCaptionProgress(0);
                  useTimelineStore.getState().computeDuration();
                }
              }}
            >
              <Icons.Mic size={12} /> {captionBusy ? `Transcribing… ${captionProgress}%` : 'Generate captions'}
            </button>

            <button
              className="sn-btn-ghost"
              style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
              disabled={captionBusy}
              onClick={() => void generateKaraoke()}
              title="Transcribe with word-level timestamps and add captions that highlight each spoken word."
            >
              <Icons.Mic size={12} /> {captionBusy ? `Transcribing… ${captionProgress}%` : 'Generate karaoke captions'}
            </button>
          </>
        )}
      </InspectorSection>
    </div>
  );
}

function PresetGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="sn-section-label" style={{ marginBottom: 6, fontSize: 9 }}>{label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>{children}</div>
    </div>
  );
}

function PresetCard({
  name,
  kind,
  selected,
  onClick,
}: {
  name: string;
  kind: 'in' | 'out' | 'loop';
  selected: boolean;
  onClick: () => void;
}) {
  // Each card loops a CSS keyframe animation that matches the preset, so the user can preview
  // the motion without selecting it. Class names are defined in globals.css.
  const animClass = `sn-anim-${kind}-${slug(name)}`;
  return (
    <button
      onClick={onClick}
      style={{
        aspectRatio: '1',
        borderRadius: 6,
        border: `1px solid ${selected ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
        background: selected ? 'rgba(200,242,58,0.06)' : 'var(--bg-base)',
        boxShadow: selected ? '0 0 0 2px rgba(200,242,58,0.18)' : 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        color: selected ? 'var(--accent-primary)' : 'var(--text-secondary)',
        gap: 4,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {name === 'None' ? (
        <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>—</span>
      ) : (
        <span className={`display ${animClass}`} style={{ fontSize: 16 }}>
          Abc
        </span>
      )}
      <span style={{ fontSize: 8.5, opacity: 0.9, letterSpacing: 0.3, textAlign: 'center' }}>{name}</span>
    </button>
  );
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/↑/, 'up')
    .replace(/↓/, 'down')
    .replace(/←/, 'left')
    .replace(/→/, 'right')
    .replace(/[^a-z0-9]+/g, '');
}
