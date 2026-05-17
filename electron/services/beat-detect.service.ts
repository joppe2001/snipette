import { spawn, type ChildProcess } from 'node:child_process';
import log from 'electron-log';
import { getFFmpegPath } from './ffmpeg.service';

/**
 * Result cache keyed by `(assetId, threshold, minIntervalMs, sensitivityPreset)`. The
 * detection is deterministic for a given (file, params) tuple, so repeated calls with
 * identical inputs (typical when a user nudges an unrelated slider, opens/closes the
 * panel, etc.) can short-circuit the FFmpeg PCM extract entirely. Bounded with a simple
 * FIFO so a long editing session can't grow the map unbounded.
 *
 * NOTE: `assetId` is the cache key, not `sourcePath` — callers pass an explicit
 * `cacheKey` (typically the asset id from the renderer) because the path on disk could
 * be re-resolved differently between runs. We default to `sourcePath` when no explicit
 * key is given to keep the back-compat contract.
 */
const BEATS_CACHE = new Map<string, number[]>();
const BEATS_CACHE_MAX = 20;

function cachePut(key: string, beats: number[]): void {
  if (BEATS_CACHE.size >= BEATS_CACHE_MAX) {
    const firstKey = BEATS_CACHE.keys().next().value;
    if (firstKey !== undefined) BEATS_CACHE.delete(firstKey);
  }
  BEATS_CACHE.set(key, beats);
}

/**
 * Track the in-flight FFmpeg process. If the renderer fires another `detectBeats` while
 * a prior one is still extracting PCM (typical with a threshold-slider drag), we SIGTERM
 * the old proc so it doesn't keep eating CPU on a result the user already discarded.
 * Mirrors the cancel pattern used by whisper.service.ts.
 */
let currentProc: ChildProcess | null = null;

export function cancelBeatDetection(): void {
  if (currentProc) {
    currentProc.kill('SIGTERM');
    currentProc = null;
  }
}

export interface DetectBeatsOpts {
  /**
   * Adaptive-threshold multiplier. A frame qualifies as a beat candidate when its energy
   * exceeds the local rolling-average energy by this factor. 1.5 is balanced — drop
   * toward ~1.2 for sparse / low-energy material, raise toward ~2.0+ for percussive
   * music to catch only the strongest hits.
   */
  threshold?: number;
  /**
   * Minimum interval between accepted beats in milliseconds. Used to thin out raw onsets
   * into musically-relevant beats (downbeats / bar starts / etc.). Within each window
   * the algorithm keeps the **strongest** candidate, not the first — so the returned
   * beats tend to land on the loudest hit per window rather than on whatever transient
   * happens to come first. Defaults to 500 ms (~2 beats/sec). Raise to 1000–4000 for
   * CapCut-style downbeat-only output.
   */
  minIntervalMs?: number;
  /**
   * Optional descriptor of the sensitivity preset the renderer used to derive the
   * numeric params. Folded into the cache key so two presets that happen to share a
   * threshold/minInterval combo (or future presets that add post-processing) stay
   * cache-isolated. Purely advisory — detection ignores it.
   */
  sensitivityPreset?: string;
  /**
   * Stable identifier for the asset being analysed (typically the renderer-side asset
   * id). Used as the primary cache key. When omitted, the on-disk `sourcePath` is used.
   */
  cacheKey?: string;
}

/**
 * Detect beat timestamps in MILLISECONDS for the audio in `sourcePath`. The returned array
 * is sorted ascending. Empty array if the file has no decodable audio or is silent.
 *
 * Algorithm — spectral-energy onset detection on raw PCM (no external deps):
 *  1. Read mono 22050 Hz S16LE samples from the file via FFmpeg.
 *  2. Compute short-term energy over 1024-sample frames (~46 ms windows).
 *  3. Flag frames where energy exceeds the local rolling-average energy × `threshold`.
 *  4. Debounce: drop beats closer than `minIntervalMs` to the previous beat.
 *  5. Return [t_ms, t_ms, ...].
 *
 * Tradeoffs: for tempo-locked / percussive material this yields plausible beats — good
 * enough for music-video editing and "snap-to-beat" cuts. It is NOT a true onset detector
 * (no spectral flux, no tempo tracking). Quiet acoustic, ambient, or spoken-word content
 * will produce noisier results. A future revision can swap in an aubio binding behind the
 * same return signature without touching callers.
 */
export async function detectBeats(
  sourcePath: string,
  opts?: DetectBeatsOpts,
): Promise<number[]> {
  const threshold = opts?.threshold ?? 1.5;
  const minIntervalMs = opts?.minIntervalMs ?? 500;
  const sensitivityPreset = opts?.sensitivityPreset ?? '';
  const cacheKey = `${opts?.cacheKey ?? sourcePath}|${threshold}|${minIntervalMs}|${sensitivityPreset}`;

  // Cache hit — same asset + same params = same beats. Return a defensive copy so callers
  // mutating the array (e.g. filtering in-range) can't corrupt the cache entry.
  const cached = BEATS_CACHE.get(cacheKey);
  if (cached) return cached.slice();

  // Cancel any in-flight detection — typical when the user drags a slider and queues
  // up several detectBeats calls in quick succession. Without this, all of them run
  // to completion before any returns, pinning a CPU core on a result already stale.
  if (currentProc) {
    currentProc.kill('SIGTERM');
    currentProc = null;
  }

  const SAMPLE_RATE = 22050;
  const FRAME = 1024;
  const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;

  return new Promise<number[]>((resolve, reject) => {
    const proc = spawn(getFFmpegPath(), [
      '-i',
      sourcePath,
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-',
    ]);
    currentProc = proc;

    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('error', (err) => {
      log.error('[beats] ffmpeg spawn error', err);
      if (currentProc === proc) currentProc = null;
      reject(err);
    });
    proc.on('close', (code, signal) => {
      if (currentProc === proc) currentProc = null;
      // SIGTERM means we cancelled it ourselves (a newer detectBeats arrived). Reject with
      // a recognisable error so callers can swallow it instead of surfacing it as a
      // failure toast.
      if (signal === 'SIGTERM') {
        reject(new Error('Beat detection cancelled'));
        return;
      }
      if (code !== 0) {
        log.error('[beats] ffmpeg pcm failed', stderr.slice(-500));
        reject(new Error('Beat detection failed during PCM extract'));
        return;
      }

      const buf = Buffer.concat(chunks);
      const totalSamples = Math.floor(buf.length / 2);
      const frameCount = Math.floor(totalSamples / FRAME);
      if (frameCount === 0) {
        cachePut(cacheKey, []);
        resolve([]);
        return;
      }

      // Per-frame mean-square energy. Float32 keeps the math cheap and is plenty precise
      // for relative comparisons against a rolling average.
      const energy = new Float32Array(frameCount);
      for (let f = 0; f < frameCount; f++) {
        let sum = 0;
        const offset = f * FRAME * 2;
        for (let i = 0; i < FRAME; i++) {
          const s = buf.readInt16LE(offset + i * 2);
          sum += s * s;
        }
        energy[f] = sum / FRAME;
      }

      // Rolling window ≈ 1 second of past frames. Adaptive thresholding means quiet
      // sections still surface their own internal peaks, instead of being drowned out
      // by louder neighbors elsewhere in the track.
      const WINDOW = Math.max(1, Math.round(1000 / FRAME_MS));

      // Pass 1: collect every onset candidate above threshold, with its "strength"
      // (= energy / local-average — how much it stands out from its neighborhood).
      const candidates: { tMs: number; strength: number }[] = [];
      for (let f = 0; f < frameCount; f++) {
        const lo = Math.max(0, f - WINDOW);
        const hi = Math.min(frameCount, f + 1);
        let avg = 0;
        for (let i = lo; i < hi; i++) avg += energy[i];
        avg /= hi - lo;
        if (avg <= 0) continue;
        if (energy[f] > avg * threshold) {
          candidates.push({
            tMs: f * FRAME_MS,
            strength: energy[f] / avg,
          });
        }
      }

      // Pass 2: walk the candidates and within each `minIntervalMs` window keep the
      // STRONGEST one. We also enforce that accepted beats are at least
      // `minIntervalMs` apart from each other — without this guard, "strongest of an
      // early window" + "strongest of a late window" could land closer together than
      // the user-set gap (e.g. window N's strongest is its last sample, window N+1's
      // strongest is its first). Anchor the gap to the LAST ACCEPTED beat, not to
      // window edges, so the slider's intent is preserved.
      const beats: number[] = [];
      let lastAcceptedMs = -Infinity;
      let i = 0;
      while (i < candidates.length) {
        // Skip candidates that fall inside the cooldown after the previous accept.
        if (candidates[i].tMs < lastAcceptedMs + minIntervalMs) {
          i++;
          continue;
        }
        const windowEnd = candidates[i].tMs + minIntervalMs;
        let bestIdx = i;
        let bestStrength = candidates[i].strength;
        let j = i + 1;
        while (j < candidates.length && candidates[j].tMs < windowEnd) {
          if (candidates[j].strength > bestStrength) {
            bestStrength = candidates[j].strength;
            bestIdx = j;
          }
          j++;
        }
        const chosenMs = candidates[bestIdx].tMs;
        beats.push(Math.round(chosenMs));
        lastAcceptedMs = chosenMs;
        i = j;
      }

      // Cache a frozen copy so the array we return (sliced from cache by callers) and the
      // cached array are independent. Cap is enforced inside `cachePut`.
      cachePut(cacheKey, beats.slice());
      resolve(beats);
    });
  });
}
