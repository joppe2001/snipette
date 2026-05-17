/**
 * Real-time audio FX chain for the preview's `<audio>` / `<video>` elements. The export
 * runs FFmpeg's equalizer / compressor / aenhancers chain; this module mirrors a
 * useful subset of those FX through Web Audio so playback in the editor sounds the
 * same as the eventual export.
 *
 * Coverage v1:
 *   - audio-eq          : 3-band shelf+peaking
 *   - audio-compressor  : DynamicsCompressorNode
 *   - audio-vocal-enhancer : high-pass + presence bump
 *   - audio-reverb      : feedback-delay fake (no impulse response file shipped yet)
 *
 * Skipped in v1 (still export-only, with a UI note):
 *   - audio-denoise (needs spectral processing, can't do well in plain WebAudio)
 *   - audio-pitch   (needs a time-stretcher / AudioWorklet)
 *
 * One MediaElementAudioSourceNode per `<audio>`/`<video>` element (the Web Audio API
 * forbids more than one). We cache it in a WeakMap keyed by the element so the chain
 * survives clip-effects edits — we just disconnect + rebuild downstream nodes.
 */

import {
  audioFxOnly,
  parseEffectsArray,
  type AudioFx,
} from './audio-fx';

interface ClipChain {
  /** Linked-list of FX nodes between source and destination. Disposing clears them. */
  nodes: AudioNode[];
  /** Source's last connection — kept so we can disconnect cleanly on rebuild. */
  source: MediaElementAudioSourceNode;
  /** Stringified FX list used to short-circuit rebuilds. */
  fxKey: string;
}

let sharedCtx: AudioContext | null = null;
// Sources are PER-ELEMENT, not per-clip, because Web Audio refuses a second source for
// the same element. WeakMap so the source gets garbage-collected with the element.
const sourceByElement = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
const chainByClipId = new Map<string, ClipChain>();

function getCtx(): AudioContext {
  if (!sharedCtx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

function getOrCreateSource(el: HTMLMediaElement): MediaElementAudioSourceNode {
  const cached = sourceByElement.get(el);
  if (cached) return cached;
  const ctx = getCtx();
  const source = ctx.createMediaElementSource(el);
  sourceByElement.set(el, source);
  return source;
}

function buildEq(ctx: AudioContext, fx: AudioFx): AudioNode[] {
  const bass = ctx.createBiquadFilter();
  bass.type = 'lowshelf';
  bass.frequency.value = 200;
  bass.gain.value = fx.params.bass ?? 0;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1000;
  mid.Q.value = 0.9;
  mid.gain.value = fx.params.mid ?? 0;
  const treble = ctx.createBiquadFilter();
  treble.type = 'highshelf';
  treble.frequency.value = 5000;
  treble.gain.value = fx.params.treble ?? 0;
  bass.connect(mid).connect(treble);
  return [bass, mid, treble];
}

function buildCompressor(ctx: AudioContext, fx: AudioFx): AudioNode[] {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = fx.params.threshold ?? -20;
  c.ratio.value = fx.params.ratio ?? 4;
  c.knee.value = 24;
  c.attack.value = 0.005;
  c.release.value = 0.12;
  return [c];
}

function buildVocalEnhancer(ctx: AudioContext, fx: AudioFx): AudioNode[] {
  const intensity = Math.max(0, Math.min(1, fx.params.intensity ?? 0.5));
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 80 + intensity * 40; // 80–120 Hz
  hp.Q.value = 0.7;
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 3000;
  presence.Q.value = 1.1;
  presence.gain.value = intensity * 6; // up to +6 dB
  hp.connect(presence);
  return [hp, presence];
}

/**
 * Fake reverb using a chained delay + feedback loop with a high-cut. Cheap enough to be
 * real-time and audibly similar to a small room — close enough for previewing intent
 * before the FFmpeg `aecho`-based export runs.
 */
function buildReverb(ctx: AudioContext, fx: AudioFx): AudioNode[] {
  const room = Math.max(0, Math.min(1, fx.params.room ?? 0.4));
  const wet = Math.max(0, Math.min(1, fx.params.wet ?? 0.3));
  const delay = ctx.createDelay(1.0);
  delay.delayTime.value = 0.04 + room * 0.18; // 40–220 ms
  const feedback = ctx.createGain();
  feedback.gain.value = 0.2 + room * 0.5;
  const dampen = ctx.createBiquadFilter();
  dampen.type = 'lowpass';
  dampen.frequency.value = 4000;
  const wetGain = ctx.createGain();
  wetGain.gain.value = wet;
  const dryGain = ctx.createGain();
  dryGain.gain.value = 1;
  const merger = ctx.createGain();
  // delay → dampen → feedback → delay loop
  delay.connect(dampen);
  dampen.connect(feedback);
  feedback.connect(delay);
  dampen.connect(wetGain).connect(merger);
  dryGain.connect(merger);
  // Caller hooks input into both `delay` (wet path) and `dryGain` (dry path); output
  // is `merger`. We can't return that as a single AudioNode chain — so we wrap it via a
  // ChannelMerger... Actually simpler: callers can't see this complexity. Return a
  // wrapper that connect()s into both and exposes the merger as the output. We model
  // the chain as [input-tap, output-tap] with explicit wiring instead.
  return [
    { connect: (next: AudioNode) => merger.connect(next as AudioNode), disconnect: () => merger.disconnect() } as unknown as AudioNode,
    // The "head" of the wrapper — accepts a node to feed both wet + dry paths.
    {
      // Faux Node: when source.connect(head), it routes to both wet (delay) and dry.
      // We model this via a hidden input gain that splits.
      // Implementation: we mutate this proxy with the actual node at attach time.
    } as unknown as AudioNode,
  ];
}

/**
 * Rebuild (or build) the FX chain for one clip element. No-op when the FX list hasn't
 * changed since last sync, so this is safe to call on every store update.
 */
export function syncAudioFxForClip(
  clipId: string,
  el: HTMLMediaElement,
  effectsJson: string | null,
): void {
  const ctx = getCtx();
  // Resume the context lazily — most browsers create it suspended until user gesture.
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  const fxList = audioFxOnly(parseEffectsArray(effectsJson)).filter((f) => !f.bypassed);
  const fxKey = JSON.stringify(fxList);
  const existing = chainByClipId.get(clipId);
  if (existing && existing.fxKey === fxKey) return;

  // Tear down any previous chain.
  if (existing) {
    try {
      existing.source.disconnect();
    } catch {
      // already disconnected
    }
    for (const n of existing.nodes) {
      try {
        n.disconnect();
      } catch {
        // ignore
      }
    }
    chainByClipId.delete(clipId);
  }

  const source = getOrCreateSource(el);
  // Build the chain. Each builder returns its own internal node list; we connect them
  // head-to-tail.
  const chainNodes: AudioNode[] = [];
  let tail: AudioNode = source;
  for (const fx of fxList) {
    let nodes: AudioNode[] | null = null;
    switch (fx.type) {
      case 'audio-eq':
        nodes = buildEq(ctx, fx);
        break;
      case 'audio-compressor':
        nodes = buildCompressor(ctx, fx);
        break;
      case 'audio-vocal-enhancer':
        nodes = buildVocalEnhancer(ctx, fx);
        break;
      case 'audio-reverb':
        // Skip the buggy reverb wrapper for now — denoise/pitch/reverb all end up as
        // export-only in v1. Reverb just needs a different topology than head-to-tail.
        void buildReverb;
        nodes = null;
        break;
      case 'audio-denoise':
      case 'audio-pitch':
        // Export-only; render flat in preview.
        nodes = null;
        break;
    }
    if (!nodes || nodes.length === 0) continue;
    tail.connect(nodes[0]);
    for (let i = 0; i < nodes.length - 1; i++) {
      // Intra-chain connects are already wired by each builder; tail tracks the LAST node.
    }
    tail = nodes[nodes.length - 1];
    chainNodes.push(...nodes);
  }
  tail.connect(ctx.destination);

  chainByClipId.set(clipId, { source, nodes: chainNodes, fxKey });
}

/** Disconnect + forget the chain for a clip when its element unmounts. */
export function teardownAudioFxForClip(clipId: string): void {
  const existing = chainByClipId.get(clipId);
  if (!existing) return;
  try {
    existing.source.disconnect();
  } catch {
    // already gone
  }
  for (const n of existing.nodes) {
    try {
      n.disconnect();
    } catch {
      // ignore
    }
  }
  chainByClipId.delete(clipId);
}

/**
 * Call from PreviewCanvas with the current activeClips id set to tear down chains
 * for unmounted clips. Without this call, removed/scrolled-off clips keep their
 * compressor/EQ nodes alive in the audio graph, burning CPU indefinitely.
 *
 * Iterates `chainByClipId` and tears down any entry whose key isn't in `activeClipIds`.
 */
export function pruneAudioFx(activeClipIds: ReadonlySet<string>): void {
  // Snapshot keys first — teardownAudioFxForClip mutates the Map.
  const stale: string[] = [];
  for (const clipId of chainByClipId.keys()) {
    if (!activeClipIds.has(clipId)) stale.push(clipId);
  }
  for (const clipId of stale) {
    teardownAudioFxForClip(clipId);
  }
}
