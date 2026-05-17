/**
 * Clip-level audio FX entries (EQ, Reverb, Compressor, Denoise, Pitch, Vocal Enhancer).
 *
 * Like motion FX, audio FX live inside a clip's `effects_json` array. The two effect
 * families coexist in the same JSON: motion entries store `{ type, intensity }`, audio
 * entries store `{ type, params }`. We distinguish them by the `audio-` type prefix.
 *
 * Inspector + FFmpeg export both consume this module to keep the parameter spec in one
 * place — the UI renders sliders straight off `AUDIO_FX_LIBRARY`, the FFmpeg filter
 * builder reads the same `params` map at export time.
 */

export type AudioFxType =
  | 'audio-eq'
  | 'audio-reverb'
  | 'audio-compressor'
  | 'audio-denoise'
  | 'audio-pitch'
  | 'audio-vocal-enhancer';

export interface AudioFx {
  type: AudioFxType;
  params: Record<string, number>;
  /** When true, the FX is in the chain but skipped by the FFmpeg builder. Lets the user
   *  audition without losing their dialed-in settings. */
  bypassed?: boolean;
}

export interface AudioFxParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  defaultValue: number;
  suffix?: string;
  step?: number;
}

export interface AudioFxDef {
  type: AudioFxType;
  name: string;
  /** Accent color (hex) — used by the FX inspector to color-code each card. */
  accent?: string;
  description: string;
  params: AudioFxParamSpec[];
}

export const AUDIO_FX_LIBRARY: AudioFxDef[] = [
  {
    type: 'audio-eq',
    name: 'EQ',
    accent: '#3AC8F2',
    description: 'Bass · Mid · Treble',
    params: [
      { key: 'bass', label: 'Bass', min: -12, max: 12, defaultValue: 0, suffix: 'dB' },
      { key: 'mid', label: 'Mid', min: -12, max: 12, defaultValue: 0, suffix: 'dB' },
      { key: 'treble', label: 'Treble', min: -12, max: 12, defaultValue: 0, suffix: 'dB' },
    ],
  },
  {
    type: 'audio-reverb',
    name: 'Reverb',
    accent: '#9C3AF2',
    description: 'Adds room space',
    params: [
      { key: 'room', label: 'Room size', min: 0, max: 1, defaultValue: 0.4, suffix: '%' },
      { key: 'wet', label: 'Mix', min: 0, max: 1, defaultValue: 0.3, suffix: '%' },
    ],
  },
  {
    type: 'audio-compressor',
    name: 'Compressor',
    accent: '#F2A83A',
    description: 'Tames loud peaks',
    params: [
      { key: 'threshold', label: 'Threshold', min: -40, max: 0, defaultValue: -20, suffix: 'dB' },
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, defaultValue: 4, suffix: ':1' },
    ],
  },
  {
    type: 'audio-denoise',
    name: 'Noise removal',
    accent: '#3AF26E',
    description: 'Cuts hum + hiss',
    params: [
      { key: 'strength', label: 'Strength', min: 0, max: 30, defaultValue: 12, suffix: 'dB' },
    ],
  },
  {
    type: 'audio-pitch',
    name: 'Pitch shift',
    accent: '#F23AC8',
    description: 'Up or down without changing length',
    params: [
      { key: 'semitones', label: 'Semitones', min: -12, max: 12, defaultValue: 0, step: 1, suffix: 'st' },
    ],
  },
  {
    type: 'audio-vocal-enhancer',
    name: 'Vocal enhancer',
    accent: '#C8F23A',
    description: 'Adds presence + air',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 1, defaultValue: 0.5, suffix: '%' },
    ],
  },
];

const AUDIO_FX_TYPES: Set<AudioFxType> = new Set<AudioFxType>(
  AUDIO_FX_LIBRARY.map((d) => d.type),
);

export function isAudioFxType(type: string): type is AudioFxType {
  return AUDIO_FX_TYPES.has(type as AudioFxType);
}

/** Loose entry shape that captures both audio and motion FX without forcing a union. */
export interface RawEffectEntry {
  type: string;
  params?: Record<string, number>;
  intensity?: number;
  bypassed?: boolean;
  /** Free-form label used by sidecar entries like `filter-preset` to record the
   *  user-visible preset name (e.g. "Cinematic", "B&W") next to the underlying
   *  color-grade values. Not consumed by FFmpeg — purely UI metadata. */
  name?: string;
}

export function parseEffectsArray(json: string | null | undefined): RawEffectEntry[] {
  if (!json) return [];
  try {
    const raw: unknown = JSON.parse(json);
    if (Array.isArray(raw)) {
      return raw.filter(
        (e): e is RawEffectEntry =>
          !!e && typeof e === 'object' && typeof (e as { type?: unknown }).type === 'string',
      );
    }
  } catch {
    // ignore malformed
  }
  return [];
}

export function audioFxOnly(arr: RawEffectEntry[]): AudioFx[] {
  return arr
    .filter((e): e is RawEffectEntry & { type: AudioFxType } => isAudioFxType(e.type))
    .map((e) => ({
      type: e.type,
      params: e.params ?? {},
      bypassed: e.bypassed === true,
    }));
}

export function getParamSpec(type: AudioFxType, key: string): AudioFxParamSpec | undefined {
  return AUDIO_FX_LIBRARY.find((d) => d.type === type)?.params.find((p) => p.key === key);
}

export function defaultParams(type: AudioFxType): Record<string, number> {
  const def = AUDIO_FX_LIBRARY.find((d) => d.type === type);
  if (!def) return {};
  return Object.fromEntries(def.params.map((p) => [p.key, p.defaultValue]));
}
