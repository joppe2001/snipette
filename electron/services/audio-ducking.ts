/**
 * Audio-ducking + loudness-normalize helpers for the export filter graph.
 *
 * - `duckingFilter` builds a single `volume` filter with an `enable=` expression that drops
 *   gain during a list of voice-active windows. Append it to a MUSIC clip's audio chain at
 *   export time so the music ducks under the voice.
 * - `loudnormFilter` returns the EBU R128 single-pass loudnorm filter for clips flagged
 *   with an `{ type: 'audio-normalize' }` entry in `effects_json`.
 *
 * Both helpers are pure string builders — they're called from filter-graph.ts and never
 * touch state or the filesystem.
 */

export interface VoiceWindow {
  /** Timeline time (project absolute) in ms. */
  startMs: number;
  endMs: number;
}

/**
 * Build a `volume` filter with an `enable=` expression that's true whenever any voice
 * window is active. Returns null if no windows were supplied — caller should skip
 * appending in that case.
 */
export function duckingFilter(
  voiceWindowsMs: VoiceWindow[],
  duckedVolume: number,
): string | null {
  if (voiceWindowsMs.length === 0) return null;
  const conditions = voiceWindowsMs
    .map((w) => {
      const a = (w.startMs / 1000).toFixed(3);
      const b = (w.endMs / 1000).toFixed(3);
      return `between(t,${a},${b})`;
    })
    .join('+');
  return `volume=enable='${conditions}':volume=${duckedVolume.toFixed(3)}`;
}

/**
 * Returns the loudnorm filter string for normalizing audio to EBU R128 (-16 LUFS,
 * 11 LU range, -1.5 dBTP). Single-pass — adequate for podcast/vlog content.
 */
export function loudnormFilter(): string {
  return 'loudnorm=I=-16:LRA=11:TP=-1.5';
}
