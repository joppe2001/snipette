/**
 * One-click voice-processing presets. Each preset describes a full audio-FX chain tuned
 * for spoken voice: denoise → EQ → compressor → vocal enhancer (+ optional reverb).
 *
 * Applying a preset REPLACES the clip's existing audio FX list (non-audio motion FX are
 * preserved separately by `AudioFxControls`). The user can then tweak individual FX in
 * the regular Audio FX section.
 *
 * Numeric values chosen to match each preset's brief, not as exhaustive recommendations
 * — every recording's source quality differs and a final pass with the per-FX sliders is
 * expected.
 */

import type { AudioFx } from './audio-fx';

export interface VoicePreset {
  id: string;
  name: string;
  description: string;
  /** Used by the inspector card to hint at the vibe. */
  accent: string;
  fx: AudioFx[];
}

export const VOICE_PRESETS: VoicePreset[] = [
  {
    id: 'clean',
    name: 'Clean',
    description: 'Subtle noise removal + light presence. Closest to the raw take.',
    accent: '#3AC8F2',
    fx: [
      { type: 'audio-denoise', params: { strength: 8 } },
      { type: 'audio-eq', params: { bass: -3, mid: 0, treble: 1 } },
      { type: 'audio-vocal-enhancer', params: { intensity: 0.35 } },
    ],
  },
  {
    id: 'podcast',
    name: 'Podcast',
    description: 'Tight dynamics, balanced EQ, a bit of "in-the-room" air. Sensible default.',
    accent: '#C8F23A',
    fx: [
      { type: 'audio-denoise', params: { strength: 12 } },
      { type: 'audio-eq', params: { bass: -2, mid: 0, treble: 2 } },
      { type: 'audio-compressor', params: { threshold: -20, ratio: 4 } },
      { type: 'audio-vocal-enhancer', params: { intensity: 0.5 } },
    ],
  },
  {
    id: 'broadcast',
    name: 'Broadcast',
    description: 'Aggressive compression + presence boost. Punchy, radio-style.',
    accent: '#F2A83A',
    fx: [
      { type: 'audio-denoise', params: { strength: 16 } },
      { type: 'audio-eq', params: { bass: 0, mid: 1, treble: 3 } },
      { type: 'audio-compressor', params: { threshold: -24, ratio: 6 } },
      { type: 'audio-vocal-enhancer', params: { intensity: 0.7 } },
    ],
  },
  {
    id: 'warm',
    name: 'Warm',
    description: 'Lower-mid lift + gentle compression. Friendly storytelling tone.',
    accent: '#F2D08A',
    fx: [
      { type: 'audio-eq', params: { bass: 2, mid: 1, treble: 0 } },
      { type: 'audio-compressor', params: { threshold: -22, ratio: 3 } },
      { type: 'audio-vocal-enhancer', params: { intensity: 0.3 } },
    ],
  },
  {
    id: 'intimate',
    name: 'Intimate',
    description: 'Heavy compression + just enough room. Close-mic ASMR-adjacent feel.',
    accent: '#F23AC8',
    fx: [
      { type: 'audio-denoise', params: { strength: 10 } },
      { type: 'audio-eq', params: { bass: -1, mid: 0, treble: 3 } },
      { type: 'audio-compressor', params: { threshold: -28, ratio: 6 } },
      { type: 'audio-vocal-enhancer', params: { intensity: 0.6 } },
      { type: 'audio-reverb', params: { room: 0.2, wet: 0.15 } },
    ],
  },
  {
    id: 'phone',
    name: 'Phone call',
    description: 'Aggressive bass + treble cut. Stylized lo-fi voice effect.',
    accent: '#9C3AF2',
    fx: [
      { type: 'audio-eq', params: { bass: -10, mid: 3, treble: -8 } },
      { type: 'audio-compressor', params: { threshold: -18, ratio: 8 } },
    ],
  },
];

export function voicePresetById(id: string): VoicePreset | undefined {
  return VOICE_PRESETS.find((p) => p.id === id);
}
