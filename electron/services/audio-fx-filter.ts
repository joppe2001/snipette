/**
 * Translate clip-level audio FX entries into FFmpeg `-filter_complex` audio filter strings.
 *
 * The renderer stores audio FX inside a clip's `effects_json` array alongside motion FX.
 * `filter-graph.ts` parses that JSON, keeps only the audio entries (via the renderer's
 * `audioFxOnly` helper — or the type-discriminator below if called from the main process
 * without that helper), and passes them here. Each entry returns one comma-joinable
 * filter string; the caller concatenates them into the existing audio chain.
 *
 * Type note: the renderer owns the canonical `AudioFx` shape in `src/utils/audio-fx.ts`.
 * Because the Electron tsconfig doesn't include `src/`, we mirror a minimal structural
 * type here. They line up by construction — the JSON wire format is the contract.
 */

export interface AudioFxEntry {
  type: string;
  params: Record<string, number>;
}

/**
 * Convert a list of audio FX entries to FFmpeg filter strings, one per entry.
 * Unknown types are skipped silently. Returned strings are individually comma-joinable
 * and may themselves contain commas (e.g. the 3-band EQ chains three `equalizer` filters).
 */
export function audioFxToFFmpegFilters(fx: AudioFxEntry[]): string[] {
  const out: string[] = [];
  for (const entry of fx) {
    const filter = audioFxToFilter(entry);
    if (filter) out.push(filter);
  }
  return out;
}

function audioFxToFilter(entry: AudioFxEntry): string | null {
  const p = entry.params ?? {};
  switch (entry.type) {
    case 'audio-eq': {
      const bass = numberOr(p.bass, 0);
      const mid = numberOr(p.mid, 0);
      const treble = numberOr(p.treble, 0);
      return [
        `equalizer=f=100:t=q:w=1:g=${bass.toFixed(2)}`,
        `equalizer=f=1000:t=q:w=1:g=${mid.toFixed(2)}`,
        `equalizer=f=8000:t=q:w=1:g=${treble.toFixed(2)}`,
      ].join(',');
    }
    case 'audio-reverb': {
      const room = clamp(numberOr(p.room, 0.4), 0, 1);
      const wet = clamp(numberOr(p.wet, 0.3), 0, 1);
      // `aecho` is a cheap reverb stand-in: in_gain:out_gain:delays(ms):decays(0..1).
      const delay = Math.max(40, room * 80);
      const decay = clamp(0.3 + room * 0.5, 0, 0.95);
      return `aecho=0.8:${wet.toFixed(3)}:${delay.toFixed(0)}:${decay.toFixed(3)}`;
    }
    case 'audio-compressor': {
      const threshold = clamp(numberOr(p.threshold, -20), -40, 0);
      const ratio = clamp(numberOr(p.ratio, 4), 1, 20);
      return `acompressor=threshold=${threshold.toFixed(2)}dB:ratio=${ratio.toFixed(2)}:attack=20:release=250`;
    }
    case 'audio-denoise': {
      const strength = clamp(numberOr(p.strength, 12), 0, 30);
      return `afftdn=nr=${strength.toFixed(2)}:nf=-25`;
    }
    case 'audio-pitch': {
      const semitones = clamp(numberOr(p.semitones, 0), -24, 24);
      if (semitones === 0) return null;
      const sampleRate = 44100;
      const shiftedRate = Math.round(sampleRate * Math.pow(2, semitones / 12));
      const tempoFactor = Math.pow(2, -semitones / 12);
      const tempos = chainAtempo(tempoFactor);
      // 1. Shift the sample-rate up/down to change pitch (and tempo as a side effect).
      // 2. Resample back to project rate.
      // 3. Use atempo (possibly chained) to restore the original duration.
      const parts = [
        `asetrate=${shiftedRate}`,
        `aresample=${sampleRate}`,
        ...tempos.map((t) => `atempo=${t.toFixed(6)}`),
      ];
      return parts.join(',');
    }
    case 'audio-vocal-enhancer': {
      const intensity = clamp(numberOr(p.intensity, 0.5), 0, 1);
      const presence = (intensity * 4).toFixed(2);
      return `highpass=80,lowpass=12000,equalizer=f=3000:t=q:w=1.5:g=${presence}`;
    }
    default:
      return null;
  }
}

/**
 * FFmpeg's `atempo` filter only accepts factors in [0.5, 2.0]. To reach more extreme
 * factors (needed for ±12 semitone pitch shifts → tempo factors ~0.5..2.0, fine, but
 * the prompt's contract asks us to handle the case anyway), chain multiple atempo
 * filters whose product equals the desired factor.
 */
function chainAtempo(factor: number): number[] {
  if (!isFinite(factor) || factor <= 0) return [1];
  const result: number[] = [];
  let remaining = factor;
  while (remaining > 2.0) {
    result.push(2.0);
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    result.push(0.5);
    remaining /= 0.5;
  }
  result.push(remaining);
  return result;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && isFinite(value) ? value : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Type-discriminator for callers that have a mixed motion+audio entry array. Mirrors
 * the renderer's `isAudioFxType` so the main process can filter without crossing the
 * tsconfig boundary into `src/`.
 */
const AUDIO_FX_TYPES: ReadonlySet<string> = new Set([
  'audio-eq',
  'audio-reverb',
  'audio-compressor',
  'audio-denoise',
  'audio-pitch',
  'audio-vocal-enhancer',
]);

export function isAudioFxType(type: string): boolean {
  return AUDIO_FX_TYPES.has(type);
}
