/**
 * Text animation engine. Each text/sticker clip can mix one IN, one LOOP, and one OUT preset.
 * Visual styles compose with the clip's own position/style so the user can stack everything.
 */

export type TextAnimIn =
  | 'None'
  | 'Fade'
  | 'Pop'
  | 'Bounce'
  | 'Slide ↑'
  | 'Slide ↓'
  | 'Slide ←'
  | 'Slide →'
  | 'Zoom'
  | 'Rise'
  | 'Spin'
  | 'Glitch'
  | 'Typewriter'
  | 'Slam'
  | 'LetterWave'
  | 'BlockReveal';

export type TextAnimOut = 'None' | 'Fade' | 'Shrink' | 'Slide ↑' | 'Slide ↓' | 'Slide ←' | 'Slide →' | 'Dissolve';

export type TextAnimLoop =
  | 'None'
  | 'Pulse'
  | 'Float'
  | 'Shake'
  | 'Wave'
  | 'Breathe'
  | 'Jitter'
  | 'Spin'
  | 'Karaoke';

/**
 * Per-word timing for word-by-word caption highlighting (the karaoke effect).
 * `startMs`/`endMs` are relative to the clip's start time, NOT the global timeline.
 */
export interface KaraokeWordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

/**
 * Karaoke render styles for word-by-word captions:
 *  - `reveal`: each word appears as its start time hits (typewriter-by-word).
 *  - `highlight`: all words visible; active one pops in the accent colour.
 *  - `bounce`: like `highlight` but the active word also scales 1.0→1.15→1.0
 *    over its word duration (TikTok native-captions look).
 *  - `glow`: like `highlight` but the active word pulses a colored text-shadow
 *    glow (neon caption look).
 *  - `pop-each`: each word pops in (scale 0.4→1.15→1.0 with easeOutBack) as it
 *    becomes active. Words remain visible after that. Comic-style hype.
 */
export type KaraokeMode = 'reveal' | 'highlight' | 'bounce' | 'glow' | 'pop-each';

export interface TextAnimationSpec {
  in_preset: TextAnimIn;
  in_ms: number;
  out_preset: TextAnimOut;
  out_ms: number;
  loop_preset: TextAnimLoop;
  /**
   * When true, the text's opacity is multiplied by a V-shaped curve while any video
   * transition is active under it: full at the edges of the transition window, zero at
   * the midpoint. Lets text "leave" with the outgoing clip and "arrive" with the incoming
   * one. Default off — text animations stay independent of clip transitions.
   */
  fade_with_transition: boolean;
  /**
   * Typewriter speed in characters per second. Used when `in_preset === 'Typewriter'`
   * instead of stretching `in_ms` against the text length, which is hard to dial in for
   * long strings. Range ~2..30; default 14 (a comfortable narrator pace).
   */
  typewriter_cps: number;
  /**
   * Per-word timings used by the Karaoke loop preset. When present, TextOverlay
   * renders the clip as a sequence of word spans and highlights the currently
   * spoken word. Optional — clips without word timings fall back to the regular
   * single-block render even if `loop_preset === 'Karaoke'`.
   */
  word_timings?: KaraokeWordTiming[];
  /** Karaoke render style. Defaults to `highlight` (read-along TikTok look). */
  karaoke_mode?: KaraokeMode;
  /**
   * When true and `in_preset === 'Typewriter'`, a blinking caret (`|`) is
   * rendered at the end of the visible text and persists ~600ms after typing
   * completes, then fades. AI-chat aesthetic.
   */
  typewriter_cursor?: boolean;
  /**
   * BlockReveal compound preset: marks this clip as either the title or the
   * subtitle of a two-clip "block-reveal title" template. Drives slightly
   * different render branches in `inVisual()` so the two clips animate as a
   * coordinated unit. Optional — only meaningful when `in_preset === 'BlockReveal'`.
   */
  compound_role?: 'title' | 'subtitle';
  /**
   * Colour of the small rectangle that briefly sits behind the title before
   * the text slides out of it. Used only by the BlockReveal title clip.
   */
  block_color?: string;
  /**
   * BlockReveal compound preset (single-clip mode): when this field is present
   * (even as an empty string), the renderer treats the clip as a *compound*
   * title+subtitle clip. `text_content` holds the title, this holds the
   * subtitle row that drops in after the title settles. Undefined means the
   * clip is a plain (non-compound) text clip.
   */
  subtitle_text?: string;
  /**
   * Independent style JSON for the subtitle row of a compound BlockReveal
   * clip. Shape is `TextStyleFull` serialized — font, color, weight, etc. —
   * so the subtitle can have a different look from the title's
   * `text_style_json`. Optional; absent → renderer reuses the title style.
   */
  subtitle_style_json?: string;
}

export const DEFAULT_TEXT_ANIM: TextAnimationSpec = {
  in_preset: 'None',
  in_ms: 320,
  out_preset: 'None',
  out_ms: 200,
  loop_preset: 'None',
  fade_with_transition: false,
  typewriter_cps: 14,
};

function parseWordTimings(raw: unknown): KaraokeWordTiming[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: KaraokeWordTiming[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const word = typeof o.word === 'string' ? o.word : '';
    const startMs = typeof o.startMs === 'number' ? o.startMs : NaN;
    const endMs = typeof o.endMs === 'number' ? o.endMs : NaN;
    if (!word || !Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    out.push({ word, startMs, endMs });
  }
  return out.length > 0 ? out : undefined;
}

/** Be forgiving with older shape `{ preset, in_ms, out_ms, loop }` from earlier builds. */
export function parseTextAnimation(json: string | null): TextAnimationSpec {
  if (!json) return { ...DEFAULT_TEXT_ANIM };
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (typeof raw.in_preset === 'string') {
      // New shape
      const km = raw.karaoke_mode;
      const validKaraokeMode: KaraokeMode | undefined =
        km === 'reveal' || km === 'highlight' || km === 'bounce' || km === 'glow' || km === 'pop-each'
          ? km
          : undefined;
      const role = raw.compound_role;
      const validRole: 'title' | 'subtitle' | undefined =
        role === 'title' || role === 'subtitle' ? role : undefined;
      return {
        in_preset: (raw.in_preset as TextAnimIn) ?? 'None',
        in_ms: typeof raw.in_ms === 'number' ? raw.in_ms : 320,
        out_preset: (raw.out_preset as TextAnimOut) ?? 'None',
        out_ms: typeof raw.out_ms === 'number' ? raw.out_ms : 200,
        loop_preset: (raw.loop_preset as TextAnimLoop) ?? 'None',
        fade_with_transition: raw.fade_with_transition === true,
        typewriter_cps:
          typeof raw.typewriter_cps === 'number' && raw.typewriter_cps > 0
            ? raw.typewriter_cps
            : 14,
        word_timings: parseWordTimings(raw.word_timings),
        karaoke_mode: validKaraokeMode,
        typewriter_cursor: raw.typewriter_cursor === true,
        compound_role: validRole,
        block_color: typeof raw.block_color === 'string' ? raw.block_color : undefined,
        subtitle_text: typeof raw.subtitle_text === 'string' ? raw.subtitle_text : undefined,
        subtitle_style_json:
          typeof raw.subtitle_style_json === 'string' ? raw.subtitle_style_json : undefined,
      };
    }
    // Legacy shape — `preset` was the IN preset and `loop` was a boolean.
    return {
      in_preset: (raw.preset as TextAnimIn) ?? 'None',
      in_ms: typeof raw.in_ms === 'number' ? raw.in_ms : 320,
      out_preset: 'None',
      out_ms: typeof raw.out_ms === 'number' ? raw.out_ms : 200,
      loop_preset: raw.loop ? 'Pulse' : 'None',
      fade_with_transition: false,
      typewriter_cps: 14,
    };
  } catch {
    return { ...DEFAULT_TEXT_ANIM };
  }
}

export interface TextAnimationVisual {
  opacity: number;
  /** Composes with the clip's own transform — appended after it. */
  transform: string;
  filter?: string;
  /** When non-null, only this slice of `text_content` should render (typewriter). */
  visibleText?: string;
  /**
   * IN-progress for per-character / per-segment renderers (LetterWave). When set, the
   * renderer expands the text into a `<span>` per grapheme and staggers each one's
   * opacity+translateY by index. 1.0 = animation finished. Undefined when the renderer
   * should NOT split text.
   */
  letterWaveProgress?: number;
  /**
   * IN-progress for the BlockReveal compound preset, 0..1. Title and subtitle use
   * this value (with `compound_role` from the spec) to drive their respective
   * mask reveal / drop-down animation in the TextOverlay branch. Undefined when
   * the BlockReveal preset isn't active.
   */
  blockRevealProgress?: number;
}

const IDLE: TextAnimationVisual = { opacity: 1, transform: '' };

/**
 * Compute the animation visual at a given playhead time for a clip with the given spec.
 *  - relativeMs = playheadMs − clip.start_time_ms (0 .. duration_ms)
 *  - IN phase = first `in_ms` of the clip
 *  - OUT phase = last `out_ms` of the clip
 *  - Otherwise loop phase (or idle if no loop)
 *
 * Typewriter is special: visibleText is computed regardless of phase so the chars stay revealed
 * once the IN phase finishes.
 */
export function computeTextAnimation(
  text: string,
  relativeMs: number,
  durationMs: number,
  spec: TextAnimationSpec,
): TextAnimationVisual {
  const inMs = Math.min(spec.in_ms, durationMs / 2);
  const outMs = Math.min(spec.out_ms, durationMs / 2);
  const tIn = inMs > 0 ? Math.min(1, Math.max(0, relativeMs / inMs)) : 1;
  const outStart = durationMs - outMs;

  // Typewriter visibility (always computed). Uses chars-per-second for predictable
  // pacing regardless of text length — matches what users intuitively want when
  // syncing to a voiceover.
  let visibleText: string | undefined;
  if (spec.in_preset === 'Typewriter') {
    const cps = spec.typewriter_cps > 0 ? spec.typewriter_cps : 14;
    const chars = Math.min(text.length, Math.max(0, Math.floor((relativeMs / 1000) * cps)));
    visibleText = text.slice(0, chars);
  }

  if (relativeMs < inMs && spec.in_preset !== 'None') {
    const v = inVisual(spec.in_preset, tIn);
    return { ...v, visibleText };
  }
  if (outMs > 0 && relativeMs > outStart && spec.out_preset !== 'None') {
    const tOut = Math.min(1, Math.max(0, (relativeMs - outStart) / outMs));
    return { ...outVisual(spec.out_preset, tOut), visibleText };
  }
  if (spec.loop_preset !== 'None') {
    return { ...loopVisual(spec.loop_preset, relativeMs), visibleText };
  }
  return { ...IDLE, visibleText };
}

/** Easing helpers. */
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
  const c = 1.70158;
  const c3 = c + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
const easeInCubic = (t: number) => t * t * t;

function inVisual(preset: TextAnimIn, p: number): TextAnimationVisual {
  switch (preset) {
    case 'Fade':
      return { opacity: easeOutCubic(p), transform: '' };
    case 'Pop': {
      // Elastic-ish overshoot scale.
      const s = 0.3 + easeOutBack(p) * 0.7;
      return { opacity: easeOutCubic(p), transform: `scale(${s})` };
    }
    case 'Bounce': {
      // Falls into place with damped sine bounce.
      const decay = Math.pow(1 - p, 2);
      const bounce = Math.sin(p * Math.PI * 3) * decay * 18;
      return { opacity: easeOutCubic(p), transform: `translateY(${bounce}px) scale(${0.8 + p * 0.2})` };
    }
    case 'Slide ↑':
      return { opacity: easeOutCubic(p), transform: `translateY(${(1 - p) * 60}px)` };
    case 'Slide ↓':
      return { opacity: easeOutCubic(p), transform: `translateY(${-(1 - p) * 60}px)` };
    case 'Slide ←':
      return { opacity: easeOutCubic(p), transform: `translateX(${(1 - p) * 120}px)` };
    case 'Slide →':
      return { opacity: easeOutCubic(p), transform: `translateX(${-(1 - p) * 120}px)` };
    case 'Zoom':
      return { opacity: easeOutCubic(p), transform: `scale(${0.05 + p * 0.95})` };
    case 'Rise':
      return {
        opacity: easeOutCubic(p),
        transform: `translateY(${(1 - p) * 100}px) scale(${0.7 + p * 0.3})`,
      };
    case 'Spin':
      return {
        opacity: easeOutCubic(p),
        transform: `rotate(${(1 - p) * 360}deg) scale(${0.4 + p * 0.6})`,
      };
    case 'Glitch': {
      // Jitter + hue shift + opacity flicker.
      const jitter = (Math.sin(p * 40) + Math.cos(p * 33 + 1)) * (1 - p) * 8;
      const flicker = p < 0.1 ? 0 : 1;
      return {
        opacity: flicker,
        transform: `translate(${jitter}px, ${jitter * 0.5}px)`,
        filter: `hue-rotate(${(1 - p) * 90}deg)`,
      };
    }
    case 'Typewriter':
      return { opacity: 1, transform: '' };
    case 'Slam': {
      // Massive Y-drop with overshoot bounce + one-frame brightness flash.
      // Eases from -260% of height down past resting point, snaps back.
      // Output transform is in CSS pixels so the renderer can compose it directly.
      const eased = easeOutCubic(p);
      // Y starts at -240px (off-screen above), overshoots to +18px at the landing
      // moment, then settles to 0 with a damped bounce.
      const landed = Math.min(1, p / 0.62); // 0..1 by the time we "land"
      const dropY = -240 * (1 - easeOutCubic(landed));
      // After landing, add a damped bounce-back for the remaining ~0.38 of progress.
      const afterLand = Math.max(0, (p - 0.62) / 0.38);
      const bounce = afterLand < 1
        ? Math.sin(afterLand * Math.PI * 2.2) * Math.pow(1 - afterLand, 2) * 22
        : 0;
      const y = dropY + bounce;
      // One-frame brightness flash right at landing.
      const flashWindow = Math.abs(p - 0.62);
      const flash = flashWindow < 0.05 ? 1.7 - flashWindow * 10 : 1;
      // Scale a touch bigger on impact for weight.
      const s = 0.92 + eased * 0.08 + (afterLand < 1 ? Math.pow(1 - afterLand, 2) * 0.06 : 0);
      return {
        opacity: p > 0.02 ? 1 : 0,
        transform: `translateY(${y}px) scale(${s})`,
        filter: flash > 1.02 ? `brightness(${flash.toFixed(2)})` : undefined,
      };
    }
    case 'LetterWave':
      // Per-letter wave: the renderer reads `letterWaveProgress` and splits the
      // text into spans, staggering each one. The block-level transform here is
      // identity — all motion lives in the per-letter renderer.
      return { opacity: 1, transform: '', letterWaveProgress: easeOutCubic(p) };
    case 'BlockReveal':
      // The renderer reads `blockRevealProgress` + `compound_role` to drive the
      // title's clip-path inset reveal or the subtitle's translateY drop-in. From
      // the block-level perspective the wrapper is fully visible.
      return { opacity: 1, transform: '', blockRevealProgress: p };
    case 'None':
    default:
      return { ...IDLE };
  }
}

function outVisual(preset: TextAnimOut, p: number): TextAnimationVisual {
  // p: 0 at start of out window, 1 at clip end.
  const eased = easeInCubic(p);
  switch (preset) {
    case 'Fade':
      return { opacity: 1 - eased, transform: '' };
    case 'Shrink':
      return { opacity: 1 - eased, transform: `scale(${1 - eased * 0.6})` };
    case 'Slide ↑':
      return { opacity: 1 - eased, transform: `translateY(${-p * 60}px)` };
    case 'Slide ↓':
      return { opacity: 1 - eased, transform: `translateY(${p * 60}px)` };
    case 'Slide ←':
      return { opacity: 1 - eased, transform: `translateX(${-p * 120}px)` };
    case 'Slide →':
      return { opacity: 1 - eased, transform: `translateX(${p * 120}px)` };
    case 'Dissolve':
      return { opacity: 1 - eased, transform: '', filter: `blur(${p * 5}px)` };
    case 'None':
    default:
      return { ...IDLE };
  }
}

function loopVisual(preset: TextAnimLoop, timeMs: number): TextAnimationVisual {
  const t = timeMs / 1000;
  switch (preset) {
    case 'Pulse': {
      const s = 1 + Math.sin(t * 4.2) * 0.05;
      return { opacity: 1, transform: `scale(${s})` };
    }
    case 'Float': {
      const y = Math.sin(t * 1.5) * 5;
      return { opacity: 1, transform: `translateY(${y}px)` };
    }
    case 'Shake': {
      const x = Math.sin(t * 36) * 1.5 + Math.sin(t * 49 + 0.7) * 1.2;
      const y = Math.cos(t * 41) * 0.8;
      return { opacity: 1, transform: `translate(${x}px, ${y}px)` };
    }
    case 'Wave': {
      const r = Math.sin(t * 2.2) * 3;
      return { opacity: 1, transform: `rotate(${r}deg)` };
    }
    case 'Breathe': {
      const o = 0.7 + (Math.sin(t * 1.8) + 1) * 0.15;
      return { opacity: o, transform: '' };
    }
    case 'Jitter': {
      const x = (Math.sin(t * 60) + Math.cos(t * 53)) * 1.5;
      const y = (Math.cos(t * 71) - Math.sin(t * 89)) * 1.5;
      return { opacity: 1, transform: `translate(${x}px, ${y}px)` };
    }
    case 'Spin':
      return { opacity: 1, transform: `rotate(${(t * 60) % 360}deg)` };
    case 'Karaoke':
      // Karaoke is rendered per-word by TextOverlay via `computeKaraokeWordStates`.
      // From the block-level perspective the clip is fully visible — the per-word
      // styling lives in the renderer, not here.
      return { ...IDLE };
    case 'None':
    default:
      return { ...IDLE };
  }
}

/**
 * Visual state of each word at a given playhead time.
 *  - `visible`: the word should be on screen (always true in `highlight` mode; only
 *    true once `relativeMs >= startMs` in `reveal` mode).
 *  - `active`: this word is currently being spoken — render it with the accent
 *    colour and a small scale bump.
 *  - `past`: the word has already been spoken — render at full opacity (highlight)
 *    or hide (some reveal styles want this; the renderer decides).
 */
export interface KaraokeWordState {
  word: string;
  visible: boolean;
  active: boolean;
  past: boolean;
}

export function computeKaraokeWordStates(
  wordTimings: KaraokeWordTiming[],
  relativeMs: number,
  mode: KaraokeMode = 'highlight',
): KaraokeWordState[] {
  return wordTimings.map((w) => {
    const isActive = relativeMs >= w.startMs && relativeMs <= w.endMs;
    const isPast = relativeMs > w.endMs;
    const isFuture = relativeMs < w.startMs;
    // `reveal` is the only mode that keeps future words hidden. All other modes
    // (highlight / bounce / glow / pop-each) need every word laid out so the
    // sentence stays the same width as words activate.
    const visible = mode === 'reveal' ? !isFuture : true;
    return {
      word: w.word,
      visible,
      active: isActive,
      past: isPast,
    };
  });
}

/**
 * Build synthetic per-word timings by evenly splitting a segment's duration across
 * its words. Used as a fallback when the transcriber didn't provide token-level
 * timestamps. Strips empty tokens that come from collapsed whitespace.
 */
export function splitWordsEvenly(
  text: string,
  startMs: number,
  endMs: number,
): KaraokeWordTiming[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const total = Math.max(1, endMs - startMs);
  const per = total / words.length;
  return words.map((word, i) => ({
    word,
    startMs: Math.round(startMs + i * per),
    endMs: Math.round(startMs + (i + 1) * per),
  }));
}
