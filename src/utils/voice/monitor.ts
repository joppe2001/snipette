/**
 * Live monitoring for the voice studio. Routes the recorder's mic stream through an
 * optional FX chain back to the user's speakers/headphones so they can hear themselves
 * while recording.
 *
 * Strong recommendation surfaced in the UI: use headphones. Routing mic-out to the
 * speakers creates a feedback loop that anyone wearing speakers will hear about
 * three seconds before the smoke alarm.
 *
 * The FX chain is intentionally minimal:
 *   inputGain → highpass → compressor → outputGain → destination
 *
 * Highpass at 80 Hz cuts most low-end mic rumble; compressor evens out volume
 * dynamics. These map to defaults we'll bake into the saved clip's audio FX so the
 * user's recording sounds the same in playback as it did while monitoring.
 */

export type MonitorMode = 'off' | 'direct' | 'with-fx';

export interface VoiceMonitorOpts {
  audioCtx: AudioContext;
  source: AudioNode;
  initialMode?: MonitorMode;
  /** Output volume 0..1. Defaults to 0.7. */
  initialVolume?: number;
}

export interface VoiceMonitor {
  setMode: (mode: MonitorMode) => void;
  setVolume: (v: number) => void;
  /** Current FX values — useful when baking the FX into the saved clip. */
  getFxConfig: () => {
    highpassHz: number;
    compressorThresholdDb: number;
    compressorRatio: number;
    inputGain: number;
  };
  dispose: () => void;
}

export function createVoiceMonitor(opts: VoiceMonitorOpts): VoiceMonitor {
  const { audioCtx, source } = opts;
  const inputGain = audioCtx.createGain();
  inputGain.gain.value = 1;
  const highpass = audioCtx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 80;
  highpass.Q.value = 0.7;
  const compressor = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -22;
  compressor.knee.value = 24;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.12;
  const outputGain = audioCtx.createGain();
  outputGain.gain.value = opts.initialVolume ?? 0.7;

  // Direct path (no FX). Built so swapping modes doesn't allocate.
  const directGain = audioCtx.createGain();
  directGain.gain.value = opts.initialVolume ?? 0.7;

  source.connect(inputGain);
  inputGain.connect(highpass);
  highpass.connect(compressor);
  compressor.connect(outputGain);

  source.connect(directGain);

  let mode: MonitorMode = opts.initialMode ?? 'off';
  let connectedNode: AudioNode | null = null;

  const applyMode = (next: MonitorMode) => {
    mode = next;
    if (connectedNode) {
      try {
        connectedNode.disconnect(audioCtx.destination);
      } catch {
        // already disconnected
      }
      connectedNode = null;
    }
    if (next === 'direct') {
      directGain.connect(audioCtx.destination);
      connectedNode = directGain;
    } else if (next === 'with-fx') {
      outputGain.connect(audioCtx.destination);
      connectedNode = outputGain;
    }
  };
  applyMode(mode);

  return {
    setMode(next) {
      if (next === mode) return;
      applyMode(next);
    },
    setVolume(v) {
      const clamped = Math.max(0, Math.min(1, v));
      outputGain.gain.value = clamped;
      directGain.gain.value = clamped;
    },
    getFxConfig() {
      return {
        highpassHz: highpass.frequency.value,
        compressorThresholdDb: compressor.threshold.value,
        compressorRatio: compressor.ratio.value,
        inputGain: inputGain.gain.value,
      };
    },
    dispose() {
      try {
        directGain.disconnect();
        outputGain.disconnect();
        compressor.disconnect();
        highpass.disconnect();
        inputGain.disconnect();
      } catch {
        // ignore
      }
    },
  };
}
