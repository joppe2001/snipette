/**
 * Dialogue helpers. Turns a free-form multi-line script like
 *
 *   Joppe: hey
 *   Friend: hi, how are you?
 *
 * into a sequence of styled text clips ready to be added to the timeline. Speakers
 * are detected automatically; up to four get distinct styles (color + left/right
 * placement), and any extras round-robin back through those four slots so longer
 * casts still work without UI clutter.
 *
 * The styling matches a chat-bubble look — solid background + rounded corners — so
 * the result feels like the "two characters talking" overlays you see in vertical
 * scripted shorts.
 */

import type { TextStyleFull } from './text-templates';
import type { TextAnimationSpec } from './text-animation';

export interface DialogueLine {
  /** Speaker name as typed (case preserved). */
  speaker: string;
  /** Spoken text after the colon. */
  text: string;
  /** Resolved 0..3 slot — drives style + position. */
  slot: number;
}

export interface DialogueSpeaker {
  /** Display name. Normalized casing of whatever the user typed first. */
  name: string;
  slot: number;
  /** Accent color preview chip. */
  accent: string;
  /** True if this speaker sits on the left of the canvas. */
  isLeft: boolean;
}

const SPEAKER_ACCENTS: { accent: string; isLeft: boolean }[] = [
  { accent: '#3AC8F2', isLeft: true },   // Slot 0 — cyan, left
  { accent: '#F23AC8', isLeft: false },  // Slot 1 — pink, right
  { accent: '#F2A83A', isLeft: true },   // Slot 2 — orange, left
  { accent: '#3AF26E', isLeft: false },  // Slot 3 — green, right
];

export function speakerSlotMeta(slot: number): { accent: string; isLeft: boolean } {
  return SPEAKER_ACCENTS[((slot % SPEAKER_ACCENTS.length) + SPEAKER_ACCENTS.length) % SPEAKER_ACCENTS.length];
}

/**
 * Parse a multi-line script into structured lines. Each non-empty line is split on its
 * first `:` — text before becomes the speaker name (case-insensitively de-duplicated),
 * text after becomes the line. Lines without a colon are attributed to "—" (em dash)
 * so they still flow into the timeline as narration.
 */
export function parseDialogueScript(input: string): {
  lines: DialogueLine[];
  speakers: DialogueSpeaker[];
} {
  const speakerSlots = new Map<string, { slot: number; displayName: string }>();
  const lines: DialogueLine[] = [];

  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    let speaker: string;
    let text: string;
    if (colon < 0) {
      speaker = '—';
      text = line;
    } else {
      speaker = line.slice(0, colon).trim() || '—';
      text = line.slice(colon + 1).trim();
    }
    if (!text) continue;

    const key = speaker.toLowerCase();
    let entry = speakerSlots.get(key);
    if (!entry) {
      entry = { slot: speakerSlots.size, displayName: speaker };
      speakerSlots.set(key, entry);
    }
    lines.push({ speaker: entry.displayName, text, slot: entry.slot });
  }

  const speakers: DialogueSpeaker[] = Array.from(speakerSlots.values()).map(({ slot, displayName }) => ({
    name: displayName,
    slot,
    accent: speakerSlotMeta(slot).accent,
    isLeft: speakerSlotMeta(slot).isLeft,
  }));
  return { lines, speakers };
}

/**
 * Build a chat-bubble TextStyleFull for the given speaker slot. The first four slots
 * each get a distinct background color + alignment; extras wrap around.
 */
export function dialogueBubbleStyle(slot: number): TextStyleFull {
  const meta = speakerSlotMeta(slot);
  return {
    font_family: 'Sora',
    font_size: 38,
    font_weight: 700,
    color: '#FFFFFF',
    align: meta.isLeft ? 'left' : 'right',
    line_height: 1.15,
    letter_spacing: 0.01,
    stroke_color: '#0A0A0C',
    stroke_width: 0,
    bg_enabled: true,
    bg_color: meta.accent,
    bg_padding: 14,
    bg_radius: 14,
    shadow_enabled: true,
    shadow_x: 0,
    shadow_y: 4,
    shadow_blur: 16,
    shadow_color: 'rgba(0,0,0,0.45)',
  };
}

/** Per-line `position_x` offset to place left/right speakers off-center. */
export function dialoguePositionX(slot: number): number {
  return speakerSlotMeta(slot).isLeft ? -180 : 180;
}

/** Small slide-in animation default — left speakers slide from left, right from right. */
export function dialogueAnimation(slot: number): Partial<TextAnimationSpec> {
  return {
    in_preset: speakerSlotMeta(slot).isLeft ? 'Slide ←' : 'Slide →',
    in_ms: 240,
    out_preset: 'Fade',
    out_ms: 200,
    loop_preset: 'None',
  };
}

/**
 * Compute durations for each line. v1 uses a simple chars-per-second + min-duration
 * formula. Caller passes options so the modal can expose sliders for them.
 */
export function dialogueLineDurations(
  lines: DialogueLine[],
  opts: { msPerChar: number; minMs: number; gapMs: number },
): { startMs: number; durationMs: number }[] {
  const out: { startMs: number; durationMs: number }[] = [];
  let cursor = 0;
  for (const line of lines) {
    const dur = Math.max(opts.minMs, Math.round(line.text.length * opts.msPerChar));
    out.push({ startMs: cursor, durationMs: dur });
    cursor += dur + opts.gapMs;
  }
  return out;
}
