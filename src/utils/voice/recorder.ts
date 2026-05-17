/**
 * Voice recorder: thin facade over `getUserMedia` + `MediaRecorder` + an `AnalyserNode`
 * exposed for live level metering / waveform visualization. The renderer instantiates
 * one per recording session.
 *
 * Design notes
 *  - We default to webm/opus because it's universally supported by Chromium's
 *    MediaRecorder, decodes in `<video>`/`<audio>`, and FFmpeg handles it natively for
 *    export. mp4/aac is preferred on platforms that support it but Chromium does not
 *    currently encode that combo via MediaRecorder.
 *  - The recorder owns the underlying `MediaStream`; calling `dispose()` stops every
 *    track so the mic LED turns off promptly.
 *  - Pause/resume keep the same blob — we accumulate `dataavailable` chunks and stitch
 *    them in `stop()`.
 */

export interface VoiceRecorderOpts {
  /** Input device id from `enumerateDevices()`; falls back to system default if omitted. */
  deviceId?: string;
  /** If true, the recorder also disables echo cancellation and noise suppression so the
   *  captured audio is as raw as possible. Useful when the user prefers to apply our
   *  own audio FX in post. Default true. */
  rawCapture?: boolean;
  /** Preferred sample rate for the AudioContext used for metering/monitoring. */
  sampleRate?: number;
}

export interface VoiceRecorderHandle {
  stream: MediaStream;
  audioCtx: AudioContext;
  /** Single MediaStreamAudioSourceNode for the mic — shared by the analyser (built in)
   *  and by the optional monitor chain, so we avoid the multi-source compatibility issue
   *  some Chromium versions hit when you create two from the same stream. */
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  /** The MediaRecorder; null until `start()` first runs. */
  getRecorder: () => MediaRecorder | null;
  /** Currently-selected MIME for the encoded blob. */
  mimeType: string;
  start: () => void;
  pause: () => void;
  resume: () => void;
  /** Stop recording and return the accumulated blob + elapsed duration in ms. */
  stop: () => Promise<{ blob: Blob; durationMs: number; mimeType: string }>;
  dispose: () => void;
}

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
];

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  for (const t of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

export function extensionForMime(mime: string): 'webm' | 'mp4' | 'ogg' | 'wav' {
  if (mime.startsWith('audio/webm')) return 'webm';
  if (mime.startsWith('audio/ogg')) return 'ogg';
  if (mime.startsWith('audio/mp4')) return 'mp4';
  return 'webm';
}

/**
 * List the user's audio input devices. Returns an empty array if permission hasn't been
 * granted yet — call `getUserMedia` first to populate the list with labels.
 */
export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

export async function createVoiceRecorder(opts: VoiceRecorderOpts = {}): Promise<VoiceRecorderHandle> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is not available in this environment');
  }

  const constraints: MediaStreamConstraints = {
    audio: {
      deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
      echoCancellation: opts.rawCapture === false,
      noiseSuppression: opts.rawCapture === false,
      autoGainControl: opts.rawCapture === false,
      channelCount: 1,
    },
    video: false,
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const AudioCtxCtor = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  const audioCtx = new AudioCtxCtor(opts.sampleRate ? { sampleRate: opts.sampleRate } : undefined);
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);
  // Analyser does NOT route to destination — no playback by default. The monitor module
  // owns the optional playback path.

  const mimeType = pickMimeType();
  let recorder: MediaRecorder | null = null;
  const chunks: Blob[] = [];
  let startedAt = 0;
  let pausedDuration = 0;
  let lastPauseAt: number | null = null;

  function newRecorder(): MediaRecorder {
    const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    return rec;
  }

  return {
    stream,
    audioCtx,
    source,
    analyser,
    mimeType: mimeType || 'audio/webm',
    getRecorder: () => recorder,
    start() {
      chunks.length = 0;
      pausedDuration = 0;
      lastPauseAt = null;
      recorder = newRecorder();
      // 100ms chunks keep dataavailable callbacks frequent enough that pause+resume
      // doesn't drop any audio.
      recorder.start(100);
      startedAt = performance.now();
    },
    pause() {
      if (!recorder || recorder.state !== 'recording') return;
      recorder.pause();
      lastPauseAt = performance.now();
    },
    resume() {
      if (!recorder || recorder.state !== 'paused' || lastPauseAt == null) return;
      pausedDuration += performance.now() - lastPauseAt;
      lastPauseAt = null;
      recorder.resume();
    },
    async stop() {
      if (!recorder) {
        return { blob: new Blob(), durationMs: 0, mimeType: mimeType || 'audio/webm' };
      }
      // If we're still paused when stop is called, count the pause up to now.
      if (lastPauseAt != null) {
        pausedDuration += performance.now() - lastPauseAt;
        lastPauseAt = null;
      }
      const stopped = new Promise<void>((resolve) => {
        recorder!.onstop = () => resolve();
      });
      recorder.stop();
      await stopped;
      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
      const elapsed = performance.now() - startedAt - pausedDuration;
      return { blob, durationMs: Math.max(0, Math.round(elapsed)), mimeType: mimeType || 'audio/webm' };
    },
    dispose() {
      try {
        recorder?.stop();
      } catch {
        // already stopped
      }
      try {
        audioCtx.close();
      } catch {
        // already closed
      }
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    },
  };
}

/**
 * Sample the analyser's time-domain data and return:
 *  - `rms` in 0..1 (linear) — typical speech sits around 0.05..0.3
 *  - `peak` in 0..1
 *  - a copy of the time-domain buffer for waveform drawing
 */
export function sampleLevels(analyser: AnalyserNode): { rms: number; peak: number; samples: Float32Array } {
  const len = analyser.fftSize;
  const samples = new Float32Array(len);
  analyser.getFloatTimeDomainData(samples);
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const v = samples[i];
    sumSq += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sumSq / len);
  return { rms, peak, samples };
}

/**
 * Convert a linear amplitude (0..1) to a decibel value clamped to a useful display
 * range. Returns -Infinity for true silence.
 */
export function linearToDb(linear: number): number {
  if (linear <= 0) return -Infinity;
  return 20 * Math.log10(linear);
}
