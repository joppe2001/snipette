import type { TextAnimationSpec } from './text-animation';
import type { TextStyleFull } from './text-templates';

/**
 * Hook Overlay Templates — pre-built first-3-second text overlays that creators
 * use to grab attention on TikTok / Reels / Shorts. Clicking a hook tile spawns
 * a new text clip at the playhead with the full style + animation + duration +
 * position baked in.
 *
 * Each hook is keyed on its "format" (anticipation, POV, listicle, alert, story,
 * countdown) — the visual treatment is tuned to that genre. Anticipation hooks
 * pop, alerts pulse on a red ticker, countdowns typewriter in, POV slides up
 * from the bottom third, etc.
 */

export type HookCategory =
  | 'anticipation'
  | 'pov'
  | 'list'
  | 'alert'
  | 'story'
  | 'countdown';

export interface HookTemplate {
  id: string;
  name: string;
  category: HookCategory;
  emoji?: string;
  /** Default copy dropped into the new text clip. */
  text: string;
  /** Style applied verbatim to `text_style_json`. */
  style: TextStyleFull;
  /** Partial animation merged on top of DEFAULT_TEXT_ANIM. */
  animation: Partial<TextAnimationSpec>;
  /** Suggested clip duration in ms (hooks are typically 1.5s – 3.5s). */
  durationMs: number;
  /**
   * Suggested vertical offset in pixels from the canvas centre. Negative pushes
   * the overlay up (good for upper-third hooks); positive pushes it down (good
   * for POV bottom-third hooks). Zero = dead centre.
   */
  positionYOffset: number;
}

function hookStyle(overrides: Partial<TextStyleFull>): TextStyleFull {
  return {
    font_family: 'Barlow Condensed',
    font_size: 88,
    font_weight: 900,
    color: '#FFFFFF',
    align: 'center',
    line_height: 1.05,
    letter_spacing: 0.02,
    stroke_color: '#0A0A0C',
    stroke_width: 4,
    bg_enabled: false,
    bg_color: '#0A0A0C',
    bg_padding: 12,
    bg_radius: 8,
    ...overrides,
  };
}

export const HOOK_TEMPLATES: HookTemplate[] = [
  // ---------- ANTICIPATION ----------
  {
    id: 'hook-wait-for-it',
    name: 'Wait for it…',
    category: 'anticipation',
    emoji: '👀',
    text: 'wait for it…',
    style: hookStyle({
      font_family: 'Sora',
      font_size: 72,
      font_weight: 800,
      color: '#FFFFFF',
      stroke_width: 0,
      italic: true,
      shadow_enabled: true,
      shadow_x: 0,
      shadow_y: 4,
      shadow_blur: 18,
      shadow_color: 'rgba(0,0,0,0.65)',
    }),
    animation: {
      in_preset: 'Pop',
      in_ms: 320,
      loop_preset: 'Breathe',
      out_preset: 'Fade',
      out_ms: 280,
    },
    durationMs: 3000,
    positionYOffset: -280,
  },
  {
    id: 'hook-you-wont-believe',
    name: "You won't believe…",
    category: 'anticipation',
    emoji: '🤯',
    text: "YOU WON'T\nBELIEVE THIS",
    style: hookStyle({
      font_family: 'Barlow Condensed',
      font_size: 96,
      font_weight: 900,
      color: '#FFE03A',
      stroke_color: '#0A0A0C',
      stroke_width: 8,
      text_transform: 'uppercase',
      shadow_enabled: true,
      shadow_x: 0,
      shadow_y: 8,
      shadow_blur: 0,
      shadow_color: '#0A0A0C',
    }),
    animation: {
      in_preset: 'Pop',
      in_ms: 280,
      loop_preset: 'Pulse',
      out_preset: 'Shrink',
      out_ms: 240,
    },
    durationMs: 2800,
    positionYOffset: -260,
  },
  {
    id: 'hook-watch-till-end',
    name: 'Watch till the end',
    category: 'anticipation',
    emoji: '👁️',
    text: 'WATCH TILL THE END',
    style: hookStyle({
      font_family: 'Sora',
      font_size: 56,
      font_weight: 800,
      color: '#FFFFFF',
      stroke_width: 0,
      text_transform: 'uppercase',
      letter_spacing: 0.06,
      bg_enabled: true,
      bg_color: '#0A0A0C',
      bg_padding: 14,
      bg_radius: 999,
    }),
    animation: {
      in_preset: 'Slide ↓',
      in_ms: 300,
      loop_preset: 'Float',
      out_preset: 'Fade',
      out_ms: 240,
    },
    durationMs: 2500,
    positionYOffset: -320,
  },

  // ---------- POV ----------
  {
    id: 'hook-pov',
    name: 'POV: …',
    category: 'pov',
    emoji: '🎬',
    text: 'POV: you just woke up',
    style: hookStyle({
      font_family: 'Sora',
      font_size: 52,
      font_weight: 700,
      color: '#FFFFFF',
      stroke_width: 0,
      bg_enabled: true,
      bg_color: 'rgba(0,0,0,0.55)',
      bg_padding: 14,
      bg_radius: 10,
    }),
    animation: {
      in_preset: 'Slide ↑',
      in_ms: 320,
      loop_preset: 'None',
      out_preset: 'Fade',
      out_ms: 280,
    },
    durationMs: 3000,
    positionYOffset: 240,
  },
  {
    id: 'hook-tell-me-without',
    name: 'Tell me without telling me',
    category: 'pov',
    emoji: '🙃',
    text: "tell me you're an editor\nwithout telling me",
    style: hookStyle({
      font_family: 'Sora',
      font_size: 44,
      font_weight: 600,
      color: '#FFFFFF',
      stroke_width: 0,
      italic: true,
      bg_enabled: true,
      bg_color: 'rgba(0,0,0,0.5)',
      bg_padding: 12,
      bg_radius: 8,
    }),
    animation: {
      in_preset: 'Slide ↑',
      in_ms: 280,
      loop_preset: 'None',
      out_preset: 'Fade',
      out_ms: 240,
    },
    durationMs: 3200,
    positionYOffset: 260,
  },

  // ---------- LIST ----------
  {
    id: 'hook-3-things',
    name: '3 things I wish I knew',
    category: 'list',
    emoji: '📋',
    text: '3 things I wish\nI knew sooner',
    style: hookStyle({
      font_family: 'Sora',
      font_size: 56,
      font_weight: 800,
      color: '#0A0A0C',
      stroke_width: 0,
      bg_enabled: true,
      bg_color: '#FFE03A',
      bg_padding: 16,
      bg_radius: 12,
    }),
    animation: {
      in_preset: 'Slide ↓',
      in_ms: 320,
      loop_preset: 'None',
      out_preset: 'Slide ↑',
      out_ms: 280,
    },
    durationMs: 3200,
    positionYOffset: -280,
  },
  {
    id: 'hook-day-1-365',
    name: 'Day 1 / 365',
    category: 'list',
    emoji: '📅',
    text: 'DAY 1 / 365',
    style: hookStyle({
      font_family: 'JetBrains Mono',
      font_size: 72,
      font_weight: 700,
      color: '#FFFFFF',
      stroke_width: 0,
      text_transform: 'uppercase',
      letter_spacing: 0.08,
      bg_enabled: true,
      bg_color: '#0A0A0C',
      bg_padding: 14,
      bg_radius: 6,
    }),
    animation: {
      in_preset: 'Pop',
      in_ms: 240,
      loop_preset: 'Pulse',
      out_preset: 'Fade',
      out_ms: 220,
    },
    durationMs: 2400,
    positionYOffset: -300,
  },

  // ---------- ALERT ----------
  {
    id: 'hook-breaking',
    name: '🚨 BREAKING',
    category: 'alert',
    emoji: '🚨',
    text: '🚨 BREAKING',
    style: hookStyle({
      font_family: 'Sora',
      font_size: 64,
      font_weight: 900,
      color: '#FFFFFF',
      stroke_width: 0,
      text_transform: 'uppercase',
      letter_spacing: 0.06,
      bg_enabled: true,
      bg_color: '#F23A5E',
      bg_padding: 16,
      bg_radius: 8,
      shadow_enabled: true,
      shadow_x: 0,
      shadow_y: 6,
      shadow_blur: 18,
      shadow_color: 'rgba(242,58,94,0.5)',
    }),
    animation: {
      in_preset: 'Slide ←',
      in_ms: 280,
      loop_preset: 'Pulse',
      out_preset: 'Slide →',
      out_ms: 260,
    },
    durationMs: 2600,
    positionYOffset: -300,
  },
  {
    id: 'hook-stop-scrolling',
    name: 'STOP scrolling',
    category: 'alert',
    emoji: '✋',
    text: 'STOP SCROLLING',
    style: hookStyle({
      font_family: 'Barlow Condensed',
      font_size: 104,
      font_weight: 900,
      color: '#FFFFFF',
      stroke_color: '#F23A5E',
      stroke_width: 6,
      text_transform: 'uppercase',
      letter_spacing: 0.02,
      glow_enabled: true,
      glow_size: 14,
      glow_color: '#F23A5E',
    }),
    animation: {
      in_preset: 'Pop',
      in_ms: 260,
      loop_preset: 'Shake',
      out_preset: 'Fade',
      out_ms: 240,
    },
    durationMs: 2200,
    positionYOffset: 0,
  },

  // ---------- STORY ----------
  {
    id: 'hook-storytime',
    name: 'Storytime',
    category: 'story',
    emoji: '📖',
    text: 'storytime…',
    style: hookStyle({
      font_family: 'Sora',
      font_size: 64,
      font_weight: 600,
      color: '#FFFFFF',
      stroke_width: 0,
      italic: true,
      letter_spacing: 0.04,
      shadow_enabled: true,
      shadow_x: 0,
      shadow_y: 4,
      shadow_blur: 14,
      shadow_color: 'rgba(0,0,0,0.6)',
    }),
    animation: {
      in_preset: 'Fade',
      in_ms: 600,
      loop_preset: 'Float',
      out_preset: 'Dissolve',
      out_ms: 400,
    },
    durationMs: 3000,
    positionYOffset: -260,
  },
  {
    id: 'hook-no-one-talks',
    name: 'Nobody talks about this',
    category: 'story',
    emoji: '🤫',
    text: 'nobody talks\nabout this',
    style: hookStyle({
      font_family: 'Sora',
      font_size: 56,
      font_weight: 700,
      color: '#F23AC8',
      stroke_width: 0,
      italic: true,
      bg_enabled: true,
      bg_color: '#FFFFFF',
      bg_padding: 14,
      bg_radius: 14,
    }),
    animation: {
      in_preset: 'Slide ↓',
      in_ms: 320,
      loop_preset: 'None',
      out_preset: 'Slide ↑',
      out_ms: 280,
    },
    durationMs: 3000,
    positionYOffset: -240,
  },

  // ---------- COUNTDOWN ----------
  {
    id: 'hook-countdown',
    name: '3… 2… 1…',
    category: 'countdown',
    emoji: '⏳',
    text: '3… 2… 1…',
    style: hookStyle({
      font_family: 'JetBrains Mono',
      font_size: 96,
      font_weight: 800,
      color: '#C8F23A',
      stroke_width: 0,
      letter_spacing: 0.06,
      glow_enabled: true,
      glow_size: 12,
      glow_color: '#C8F23A',
    }),
    animation: {
      in_preset: 'Typewriter',
      in_ms: 1500,
      typewriter_cps: 5,
      loop_preset: 'None',
      out_preset: 'Fade',
      out_ms: 200,
    },
    durationMs: 2500,
    positionYOffset: 0,
  },
  {
    id: 'hook-here-we-go',
    name: 'Here we go',
    category: 'countdown',
    emoji: '🚀',
    text: 'HERE WE GO',
    style: hookStyle({
      font_family: 'Barlow Condensed',
      font_size: 120,
      font_weight: 900,
      color: '#FFE03A',
      stroke_color: '#0A0A0C',
      stroke_width: 6,
      text_transform: 'uppercase',
      extrude_enabled: true,
      extrude_depth: 6,
      extrude_color: '#F23A5E',
    }),
    animation: {
      in_preset: 'Zoom',
      in_ms: 360,
      loop_preset: 'Pulse',
      out_preset: 'Shrink',
      out_ms: 240,
    },
    durationMs: 2200,
    positionYOffset: 0,
  },
];

/** Group hooks by category for the picker UI. Preserves array order. */
export function groupHooksByCategory(): Record<HookCategory, HookTemplate[]> {
  const groups: Record<HookCategory, HookTemplate[]> = {
    anticipation: [],
    pov: [],
    list: [],
    alert: [],
    story: [],
    countdown: [],
  };
  for (const h of HOOK_TEMPLATES) groups[h.category].push(h);
  return groups;
}

export const HOOK_CATEGORY_LABELS: Record<HookCategory, string> = {
  anticipation: 'Anticipation',
  pov: 'POV',
  list: 'Listicle',
  alert: 'Alert',
  story: 'Story',
  countdown: 'Countdown',
};
