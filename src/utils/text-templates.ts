import type { TextAnimationSpec } from './text-animation';
import { DEFAULT_TEXT_ANIM } from './text-animation';

/**
 * Compound text templates produce a single, coordinated text clip that paints
 * BOTH a title and a subtitle row stacked together. The clip carries the title
 * in `text_content`, the subtitle in `animation.subtitle_text`, and per-row
 * styles via `text_style_json` (title) + `animation.subtitle_style_json`
 * (subtitle). TextInspector wires this up through its IPC `addClip` flow.
 *
 * Compound clips were previously two separate clips that overlapped visually,
 * making the subtitle uneditable in the preview. The single-clip model lets
 * the user click once to select and edit both rows in the inspector's Content
 * section (Title field + Subtitle field).
 */
export interface CompoundClipSpec {
  /** Title text (goes into the clip's `text_content`). */
  titleText: string;
  /** Subtitle text (goes into `animation.subtitle_text`). */
  subtitleText: string;
  /** Clip duration in ms. */
  durationMs: number;
  /** Native-pixel Y offset from the canvas centre for the whole compound block. */
  positionY: number;
  /** Style for the title row. Stored on the clip as `text_style_json`. */
  titleStyle: TextStyleFull;
  /**
   * Style for the subtitle row. Stored on the clip as
   * `animation.subtitle_style_json` (JSON-serialised) so it can live on the
   * same clip as the title's style.
   */
  subtitleStyle: TextStyleFull;
  /**
   * Animation spec for the clip. `compound_role` is forced to `'title'` by
   * the spawner — the renderer reads `subtitle_text` to know to paint both
   * rows. `subtitle_text` / `subtitle_style_json` are filled in by the
   * spawner from `subtitleText` + `subtitleStyle` above so callers don't
   * have to duplicate them here.
   */
  animation: Partial<TextAnimationSpec>;
}

export interface CompoundTemplate {
  id: string;
  name: string;
  /** Total duration the user expects from "drop & forget" — informational. */
  totalDurationMs: number;
  /** Single-clip compound spec. */
  clip: CompoundClipSpec;
}

/**
 * BlockReveal title + drop subtitle (single-clip). A small accent rectangle
 * sits on screen for ~22% of the IN window; the title slides out of it
 * (clip-path inset reveal + translateX); after the title settles (~70% of
 * the IN window), a subtitle drops from above into its resting position
 * underneath the title (translateY inside an overflow-hidden wrapper). The
 * renderer paints BOTH rows stacked; only the IN window animates, the rest
 * of the clip shows both rows in their resting state.
 */
export const COMPOUND_TEMPLATES: CompoundTemplate[] = [
  {
    id: 'block-reveal',
    name: 'Block Reveal Title',
    totalDurationMs: 3000,
    clip: {
      titleText: 'BIG IDEA',
      subtitleText: 'subtitle here',
      durationMs: 3000,
      positionY: -30,
      titleStyle: {
        font_family: 'Barlow Condensed',
        font_size: 108,
        font_weight: 900,
        color: '#FFFFFF',
        align: 'center',
        line_height: 1,
        letter_spacing: 0.02,
        stroke_color: '#0A0A0C',
        stroke_width: 0,
        bg_enabled: false,
        bg_color: '#0A0A0C',
        bg_padding: 0,
        bg_radius: 0,
        text_transform: 'uppercase',
      },
      subtitleStyle: {
        font_family: 'Sora',
        font_size: 40,
        font_weight: 600,
        color: '#FFFFFF',
        align: 'center',
        line_height: 1,
        letter_spacing: 0.04,
        stroke_color: '#0A0A0C',
        stroke_width: 0,
        bg_enabled: false,
        bg_color: '#0A0A0C',
        bg_padding: 0,
        bg_radius: 0,
      },
      animation: {
        in_preset: 'BlockReveal',
        in_ms: 900,
        out_preset: 'Fade',
        out_ms: 240,
        block_color: '#C8F23A',
      },
    },
  },
];

/**
 * CapCut-style text templates — one click applies a full style + animation combo to a text clip.
 * Each template is a "look" that creators tend to want: viral-bold, neon, retro, etc.
 */

export interface TextStyleFull {
  font_family: string;
  font_size: number;
  font_weight: number;
  color: string;
  align: 'left' | 'center' | 'right' | 'justify';
  line_height: number;
  letter_spacing: number;
  stroke_color: string;
  stroke_width: number;
  bg_enabled: boolean;
  bg_color: string;
  bg_padding: number;
  bg_radius: number;
  // Extended fields — handled by TextOverlay if present.
  shadow_enabled?: boolean;
  shadow_x?: number;
  shadow_y?: number;
  shadow_blur?: number;
  shadow_color?: string;
  glow_enabled?: boolean;
  glow_size?: number;
  glow_color?: string;
  gradient_enabled?: boolean;
  gradient_from?: string;
  gradient_to?: string;
  gradient_angle?: number;
  /** Optional CSS text-transform (uppercase / lowercase / capitalize). */
  text_transform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  /** Italic rotation (degrees) for casual templates. */
  rotation_deg?: number;
  /** 3D extrude: stacks N offset shadows of `extrude_color` to fake depth. */
  extrude_enabled?: boolean;
  extrude_depth?: number;
  extrude_color?: string;
  /** Animated rainbow gradient fill (overrides solid color). */
  rainbow_enabled?: boolean;
  /** Italic style (CSS font-style). */
  italic?: boolean;
}

export interface TextTemplate {
  id: string;
  name: string;
  defaultText: string;
  style: TextStyleFull;
  animation?: Partial<TextAnimationSpec>;
}

/**
 * Default style used for auto-generated karaoke caption clips. Large bold sans
 * with a black stroke so it reads on any background; the active-word accent
 * colour is applied per-span by the KaraokeText renderer at runtime.
 */
export const KARAOKE_STYLE: TextStyleFull = {
  font_family: 'Barlow Condensed',
  font_size: 84,
  font_weight: 900,
  color: '#FFFFFF',
  align: 'center',
  line_height: 1.05,
  letter_spacing: 0.02,
  stroke_color: '#0A0A0C',
  stroke_width: 6,
  bg_enabled: false,
  bg_color: '#0A0A0C',
  bg_padding: 8,
  bg_radius: 4,
  text_transform: 'uppercase',
  shadow_enabled: true,
  shadow_x: 0,
  shadow_y: 6,
  shadow_blur: 0,
  shadow_color: '#0A0A0C',
};

/**
 * Default animation spec for karaoke captions: a quick Pop in, the per-word
 * Karaoke loop, and a Fade out. `word_timings` is filled in by the generator.
 */
export const KARAOKE_ANIMATION: TextAnimationSpec = {
  ...DEFAULT_TEXT_ANIM,
  in_preset: 'Pop',
  in_ms: 220,
  out_preset: 'Fade',
  out_ms: 200,
  loop_preset: 'Karaoke',
  karaoke_mode: 'highlight',
};

export const TEXT_TEMPLATES: TextTemplate[] = [
  {
    id: 'plain',
    name: 'Plain',
    defaultText: 'Text',
    style: makeStyle({
      font_family: 'Sora',
      font_size: 56,
      font_weight: 700,
      color: '#FFFFFF',
      stroke_color: '#0A0A0C',
      stroke_width: 0,
    }),
  },
  {
    id: 'beast',
    name: 'Beast',
    defaultText: 'INSANE!',
    style: makeStyle({
      font_family: 'Barlow Condensed',
      font_size: 88,
      font_weight: 900,
      color: '#FFE03A',
      stroke_color: '#0A0A0C',
      stroke_width: 6,
      text_transform: 'uppercase',
      shadow_enabled: true,
      shadow_x: 0,
      shadow_y: 6,
      shadow_blur: 0,
      shadow_color: '#0A0A0C',
    }),
    animation: { in_preset: 'Pop', in_ms: 280, loop_preset: 'Pulse' },
  },
  {
    id: 'neon',
    name: 'Neon',
    defaultText: 'Glow Up',
    style: makeStyle({
      font_family: 'Barlow Condensed',
      font_size: 72,
      font_weight: 800,
      color: '#FFFFFF',
      stroke_width: 0,
      text_transform: 'uppercase',
      glow_enabled: true,
      glow_size: 16,
      glow_color: '#F23AC8',
      shadow_enabled: true,
      shadow_x: 0,
      shadow_y: 0,
      shadow_blur: 24,
      shadow_color: '#3AC8F2',
    }),
    animation: { in_preset: 'Fade', in_ms: 400, loop_preset: 'Breathe' },
  },
  {
    id: 'caption',
    name: 'Caption',
    defaultText: 'Hello world',
    style: makeStyle({
      font_family: 'Sora',
      font_size: 44,
      font_weight: 700,
      color: '#FFFFFF',
      stroke_color: '#0A0A0C',
      stroke_width: 0,
      bg_enabled: true,
      bg_color: '#000000',
      bg_padding: 14,
      bg_radius: 999,
    }),
    animation: { in_preset: 'Slide ↑', in_ms: 240 },
  },
  {
    id: 'retro',
    name: 'Retro',
    defaultText: 'GROOVY',
    style: makeStyle({
      font_family: 'Barlow Condensed',
      font_size: 84,
      font_weight: 800,
      color: '#F2A83A',
      stroke_color: '#0A0A0C',
      stroke_width: 4,
      text_transform: 'uppercase',
      shadow_enabled: true,
      shadow_x: 6,
      shadow_y: 6,
      shadow_blur: 0,
      shadow_color: '#F23A5E',
    }),
    animation: { in_preset: 'Slide ←', in_ms: 320 },
  },
  {
    id: 'glitch',
    name: 'Glitch',
    defaultText: 'ERROR',
    style: makeStyle({
      font_family: 'JetBrains Mono',
      font_size: 64,
      font_weight: 800,
      color: '#FFFFFF',
      stroke_width: 0,
      text_transform: 'uppercase',
      shadow_enabled: true,
      shadow_x: 3,
      shadow_y: 0,
      shadow_blur: 0,
      shadow_color: '#F23A5E',
    }),
    animation: { in_preset: 'Glitch', in_ms: 320, loop_preset: 'Jitter' },
  },
  {
    id: 'sub',
    name: 'Subtitle',
    defaultText: 'Subtitle text',
    style: makeStyle({
      font_family: 'Sora',
      font_size: 36,
      font_weight: 600,
      color: '#FFFFFF',
      stroke_width: 0,
      bg_enabled: true,
      bg_color: 'rgba(0,0,0,0.6)',
      bg_padding: 10,
      bg_radius: 6,
    }),
  },
  {
    id: 'pop',
    name: 'Pop Star',
    defaultText: 'YASSS',
    style: makeStyle({
      font_family: 'Barlow Condensed',
      font_size: 88,
      font_weight: 900,
      color: '#FFFFFF',
      stroke_color: '#F23AC8',
      stroke_width: 6,
      text_transform: 'uppercase',
      glow_enabled: true,
      glow_size: 12,
      glow_color: '#F23AC8',
    }),
    animation: { in_preset: 'Bounce', in_ms: 360 },
  },
  {
    id: 'tw',
    name: 'Typewriter',
    defaultText: 'Loading...',
    style: makeStyle({
      font_family: 'JetBrains Mono',
      font_size: 44,
      font_weight: 600,
      color: '#C8F23A',
      stroke_width: 0,
    }),
    animation: { in_preset: 'Typewriter', in_ms: 1400 },
  },

  // ---------- NEW TEMPLATES ----------

  {
    id: 'hype',
    name: 'Hype',
    defaultText: 'LET\'S GO',
    style: makeStyle({
      font_family: 'Barlow Condensed',
      font_size: 80,
      font_weight: 900,
      color: '#FFE03A',
      stroke_color: '#0A0A0C',
      stroke_width: 4,
      text_transform: 'uppercase',
      bg_enabled: true,
      bg_color: '#F23A5E',
      bg_padding: 16,
      bg_radius: 12,
      shadow_enabled: true,
      shadow_x: 0,
      shadow_y: 8,
      shadow_blur: 0,
      shadow_color: '#0A0A0C',
    }),
    animation: { in_preset: 'Pop', in_ms: 260, loop_preset: 'Pulse' },
  },
  {
    id: 'karaoke',
    name: 'Karaoke Pop',
    defaultText: 'sing along now',
    style: KARAOKE_STYLE,
    animation: {
      in_preset: 'Pop',
      in_ms: 220,
      out_preset: 'Fade',
      out_ms: 200,
      loop_preset: 'Karaoke',
      karaoke_mode: 'highlight',
    },
  },
  {
    id: 'streamer',
    name: 'Streamer',
    defaultText: 'LIVE NOW',
    style: makeStyle({
      font_family: 'Sora',
      font_size: 48,
      font_weight: 800,
      color: '#FFFFFF',
      stroke_width: 0,
      bg_enabled: true,
      bg_color: '#3AC8F2',
      bg_padding: 12,
      bg_radius: 4,
      text_transform: 'uppercase',
    }),
    animation: { in_preset: 'Slide ←', in_ms: 280, loop_preset: 'None' },
  },
  {
    id: 'tiktok',
    name: 'TikTok Bold',
    defaultText: 'WAIT FOR IT',
    style: makeStyle({
      font_family: 'Barlow Condensed',
      font_size: 104,
      font_weight: 900,
      color: '#FFFFFF',
      stroke_color: '#0A0A0C',
      stroke_width: 10,
      text_transform: 'uppercase',
      shadow_enabled: true,
      shadow_x: 0,
      shadow_y: 10,
      shadow_blur: 0,
      shadow_color: '#0A0A0C',
    }),
    animation: { in_preset: 'Bounce', in_ms: 320, loop_preset: 'Pulse' },
  },
  {
    id: 'news',
    name: 'News Ticker',
    defaultText: 'BREAKING!',
    style: makeStyle({
      font_family: 'Sora',
      font_size: 42,
      font_weight: 800,
      color: '#FFFFFF',
      stroke_width: 0,
      bg_enabled: true,
      bg_color: '#F23A5E',
      bg_padding: 12,
      bg_radius: 999,
      text_transform: 'uppercase',
      letter_spacing: 0.06,
    }),
    animation: { in_preset: 'Slide ←', in_ms: 320, loop_preset: 'Float' },
  },
  {
    id: 'comic',
    name: 'Comic',
    defaultText: 'POW!',
    style: makeStyle({
      font_family: 'Barlow Condensed',
      font_size: 96,
      font_weight: 900,
      color: '#FFE03A',
      stroke_color: '#0A0A0C',
      stroke_width: 8,
      text_transform: 'uppercase',
      rotation_deg: -6,
      shadow_enabled: true,
      shadow_x: 4,
      shadow_y: 4,
      shadow_blur: 0,
      shadow_color: '#F23A5E',
    }),
    animation: { in_preset: 'Pop', in_ms: 240, loop_preset: 'Wave' },
  },
  {
    id: 'movie',
    name: 'Movie Title',
    defaultText: 'THE BEGINNING',
    style: makeStyle({
      font_family: 'Sora',
      font_size: 92,
      font_weight: 300,
      color: '#D8D8E0',
      stroke_width: 0,
      text_transform: 'uppercase',
      letter_spacing: 0.32,
      shadow_enabled: true,
      shadow_x: 0,
      shadow_y: 4,
      shadow_blur: 24,
      shadow_color: 'rgba(0,0,0,0.7)',
    }),
    animation: { in_preset: 'Fade', in_ms: 1200 },
  },
  {
    id: 'vlog',
    name: 'Vlog',
    defaultText: 'my day :)',
    style: makeStyle({
      font_family: 'Sora',
      font_size: 56,
      font_weight: 600,
      color: '#FFFFFF',
      stroke_width: 0,
      rotation_deg: -4,
      italic: true,
      shadow_enabled: true,
      shadow_x: 2,
      shadow_y: 3,
      shadow_blur: 6,
      shadow_color: 'rgba(0,0,0,0.5)',
    }),
    animation: { in_preset: 'Fade', in_ms: 320, loop_preset: 'Float' },
  },
  {
    id: 'cyber',
    name: 'Cyber',
    defaultText: 'SYSTEM ON',
    style: makeStyle({
      font_family: 'JetBrains Mono',
      font_size: 64,
      font_weight: 700,
      color: '#3AC8F2',
      stroke_width: 0,
      text_transform: 'uppercase',
      letter_spacing: 0.16,
      glow_enabled: true,
      glow_size: 14,
      glow_color: '#F23AC8',
    }),
    animation: { in_preset: 'Glitch', in_ms: 380, loop_preset: 'Jitter' },
  },
  {
    id: 'sketch',
    name: 'Sketch',
    defaultText: 'outline',
    style: makeStyle({
      font_family: 'Barlow Condensed',
      font_size: 84,
      font_weight: 900,
      color: 'transparent',
      stroke_color: '#FFFFFF',
      stroke_width: 2,
      text_transform: 'uppercase',
      letter_spacing: 0.08,
    }),
    animation: { in_preset: 'Rise', in_ms: 420 },
  },
  {
    id: 'scifi',
    name: 'Sci-fi',
    defaultText: 'BOOT_SEQ',
    style: makeStyle({
      font_family: 'JetBrains Mono',
      font_size: 52,
      font_weight: 600,
      color: '#3AC8F2',
      stroke_width: 0,
      letter_spacing: 0.1,
      glow_enabled: true,
      glow_size: 10,
      glow_color: '#C8F23A',
    }),
    animation: { in_preset: 'Typewriter', in_ms: 1600 },
  },
  {
    id: 'whisper',
    name: 'Whisper',
    defaultText: 'shh...',
    style: makeStyle({
      font_family: 'Sora',
      font_size: 32,
      font_weight: 300,
      color: 'rgba(255,255,255,0.55)',
      stroke_width: 0,
      italic: true,
      letter_spacing: 0.05,
    }),
    animation: { in_preset: 'Fade', in_ms: 800, loop_preset: 'Breathe' },
  },
  {
    id: 'logodrop',
    name: 'Logo Drop',
    defaultText: 'SNIPETTE',
    style: makeStyle({
      font_family: 'Barlow Condensed',
      font_size: 112,
      font_weight: 900,
      color: '#FFFFFF',
      stroke_width: 0,
      text_transform: 'uppercase',
      letter_spacing: 0.04,
      shadow_enabled: true,
      shadow_x: 0,
      shadow_y: 12,
      shadow_blur: 32,
      shadow_color: 'rgba(0,0,0,0.8)',
      extrude_enabled: true,
      extrude_depth: 6,
      extrude_color: '#1a1a22',
    }),
    animation: { in_preset: 'Zoom', in_ms: 480, loop_preset: 'Pulse' },
  },
  {
    id: 'confession',
    name: 'Confession',
    defaultText: 'I have to tell you...',
    style: makeStyle({
      font_family: 'Sora',
      font_size: 40,
      font_weight: 600,
      color: '#F23AC8',
      stroke_width: 0,
      bg_enabled: true,
      bg_color: '#FFFFFF',
      bg_padding: 14,
      bg_radius: 16,
    }),
    animation: { in_preset: 'Slide ↓', in_ms: 320 },
  },
  {
    id: 'popquiz',
    name: 'Pop Quiz',
    defaultText: 'GUESS WHO?',
    style: makeStyle({
      font_family: 'Barlow Condensed',
      font_size: 76,
      font_weight: 900,
      color: '#F23A5E',
      stroke_color: '#0A0A0C',
      stroke_width: 3,
      text_transform: 'uppercase',
      bg_enabled: true,
      bg_color: '#FFE03A',
      bg_padding: 14,
      bg_radius: 10,
      rotation_deg: -3,
    }),
    animation: { in_preset: 'Spin', in_ms: 420, loop_preset: 'Shake' },
  },
  {
    id: 'vintage',
    name: 'Vintage Title',
    defaultText: 'Once upon a time',
    style: makeStyle({
      font_family: 'Sora',
      font_size: 64,
      font_weight: 600,
      color: '#F2A83A',
      stroke_width: 0,
      italic: true,
      letter_spacing: 0.06,
      gradient_enabled: true,
      gradient_from: '#F2D08A',
      gradient_to: '#8A5A2A',
      gradient_angle: 180,
      shadow_enabled: true,
      shadow_x: 0,
      shadow_y: 2,
      shadow_blur: 8,
      shadow_color: 'rgba(0,0,0,0.5)',
    }),
    animation: { in_preset: 'Fade', in_ms: 1000 },
  },
  {
    id: 'captionbig',
    name: 'Caption Big',
    defaultText: 'BIG NEWS',
    style: makeStyle({
      font_family: 'Sora',
      font_size: 72,
      font_weight: 800,
      color: '#FFFFFF',
      stroke_width: 0,
      bg_enabled: true,
      bg_color: '#0A0A0C',
      bg_padding: 22,
      bg_radius: 12,
      text_transform: 'uppercase',
      letter_spacing: 0.04,
    }),
    animation: { in_preset: 'Slide ↓', in_ms: 280 },
  },
  {
    id: 'rainbow',
    name: 'Rainbow',
    defaultText: 'VIBES',
    style: makeStyle({
      font_family: 'Barlow Condensed',
      font_size: 96,
      font_weight: 900,
      color: '#FFFFFF',
      stroke_width: 0,
      text_transform: 'uppercase',
      letter_spacing: 0.04,
      rainbow_enabled: true,
    }),
    animation: { in_preset: 'Pop', in_ms: 320, loop_preset: 'Float' },
  },
  {
    id: 'extrude',
    name: '3D Extrude',
    defaultText: 'POP OUT',
    style: makeStyle({
      font_family: 'Barlow Condensed',
      font_size: 96,
      font_weight: 900,
      color: '#FFE03A',
      stroke_width: 0,
      text_transform: 'uppercase',
      extrude_enabled: true,
      extrude_depth: 10,
      extrude_color: '#F23A5E',
    }),
    animation: { in_preset: 'Rise', in_ms: 380, loop_preset: 'Pulse' },
  },
  {
    id: 'spotlight',
    name: 'Spotlight',
    defaultText: 'WOW',
    style: makeStyle({
      font_family: 'Barlow Condensed',
      font_size: 144,
      font_weight: 900,
      color: '#FFFFFF',
      stroke_width: 0,
      text_transform: 'uppercase',
      letter_spacing: 0.02,
      glow_enabled: true,
      glow_size: 28,
      glow_color: 'rgba(255,255,255,0.55)',
      shadow_enabled: true,
      shadow_x: 0,
      shadow_y: 0,
      shadow_blur: 60,
      shadow_color: 'rgba(255,255,255,0.35)',
    }),
    animation: { in_preset: 'Zoom', in_ms: 520, loop_preset: 'Breathe' },
  },
];

function makeStyle(overrides: Partial<TextStyleFull>): TextStyleFull {
  return {
    font_family: 'Sora',
    font_size: 56,
    font_weight: 700,
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
    ...overrides,
  };
}

/** Build the CSS for a TextOverlay's `<span>` from an extended TextStyleFull. */
export function textStyleToCss(style: Partial<TextStyleFull>): React.CSSProperties {
  const css: React.CSSProperties = {
    display: 'inline-block',
    fontFamily: style.font_family ?? 'Sora',
    fontSize: style.font_size ?? 32,
    fontWeight: style.font_weight ?? 700,
    color: style.color ?? '#fff',
    textAlign: 'center',
    letterSpacing: `${(style.letter_spacing ?? 0.02)}em`,
    lineHeight: style.line_height ?? 1.05,
    textTransform: style.text_transform ?? 'none',
    fontStyle: style.italic ? 'italic' : 'normal',
    padding: style.bg_padding ?? 0,
    background: style.bg_enabled ? style.bg_color ?? '#0A0A0C' : 'transparent',
    borderRadius: style.bg_radius ?? 0,
    // Wrap rules: cap at the parent wrapper's width, honor explicit newlines from
    // in-place editing, and break long unbreakable words (e.g. "nihongomaster") so the
    // text stays inside the canvas rather than overflowing off-screen.
    maxWidth: '100%',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowWrap: 'anywhere',
    boxSizing: 'border-box',
  };

  if ((style.stroke_width ?? 0) > 0) {
    css.WebkitTextStroke = `${style.stroke_width}px ${style.stroke_color ?? '#0A0A0C'}`;
  }

  // Compose shadow + glow + 3D extrude as a single text-shadow stack.
  const shadows: string[] = [];

  // 3D extrude is rendered FIRST so the shadow/glow layer on top of it.
  if (style.extrude_enabled) {
    const depth = Math.max(1, Math.min(40, style.extrude_depth ?? 6));
    const color = style.extrude_color ?? '#0A0A0C';
    for (let i = 1; i <= depth; i++) {
      shadows.push(`${i}px ${i}px 0 ${color}`);
    }
  }

  if (style.shadow_enabled) {
    const x = style.shadow_x ?? 0;
    const y = style.shadow_y ?? 4;
    const blur = style.shadow_blur ?? 0;
    const color = style.shadow_color ?? '#0A0A0C';
    shadows.push(`${x}px ${y}px ${blur}px ${color}`);
  }
  if (style.glow_enabled) {
    const size = style.glow_size ?? 12;
    const color = style.glow_color ?? '#C8F23A';
    // Build a 3-layer glow for a soft falloff.
    shadows.push(`0 0 ${size}px ${color}`);
    shadows.push(`0 0 ${size * 2}px ${color}`);
    shadows.push(`0 0 ${size * 3}px ${color}`);
  }
  if (shadows.length > 0) css.textShadow = shadows.join(', ');

  // Animated rainbow fill takes precedence over solid color.
  if (style.rainbow_enabled) {
    css.backgroundImage =
      'linear-gradient(90deg, #f23a5e, #f2a83a, #ffe03a, #3af26e, #3ac8f2, #9c3af2, #f23ac8, #f23a5e)';
    css.backgroundSize = '300% 100%';
    css.backgroundClip = 'text';
    css.WebkitBackgroundClip = 'text';
    css.color = 'transparent';
    css.WebkitTextFillColor = 'transparent';
    css.animation = 'sn-text-rainbow 4s linear infinite';
  } else if (style.gradient_enabled && style.gradient_from && style.gradient_to) {
    // Gradient fill (clip-path technique).
    const angle = style.gradient_angle ?? 180;
    css.backgroundImage = `linear-gradient(${angle}deg, ${style.gradient_from}, ${style.gradient_to})`;
    css.backgroundClip = 'text';
    css.WebkitBackgroundClip = 'text';
    css.color = 'transparent';
    css.WebkitTextFillColor = 'transparent';
  }

  return css;
}
