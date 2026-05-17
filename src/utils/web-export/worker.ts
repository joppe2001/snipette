/**
 * Web Worker entry for the canvas/WebCodecs orchestrator.
 *
 * Intentionally minimal in this revision: the worker holds the OffscreenCanvas, the
 * encoder, and the muxer; the main thread still owns the FrameSource (because hidden
 * `<video>` elements live on the DOM). The main thread reads frames per playhead time,
 * `transfer`s them to the worker, and the worker composites + encodes.
 *
 * Right now this file ships the protocol contract only — the actual orchestrator runs on
 * the main thread (see ./index.ts). When we move to a `VideoDecoder`-based frame source,
 * the whole pipeline can move here.
 */

/* eslint-disable no-restricted-globals */
export type WorkerInbound =
  | { type: 'init'; width: number; height: number; fps: number; bitrate: number; codec: string }
  | { type: 'frame'; timestampMicros: number; frame: VideoFrame }
  | { type: 'finalize' }
  | { type: 'abort' };

export type WorkerOutbound =
  | { type: 'ready' }
  | { type: 'encoded'; frameIdx: number }
  | { type: 'done'; buffer: ArrayBuffer }
  | { type: 'error'; error: string };

// Stub: only declares the protocol — actual implementation lives in orchestrator.ts on
// the main thread. Future work: re-implement runOrchestrator here so we can use a
// VideoDecoder pipeline and free the main thread.
self.onmessage = (event: MessageEvent) => {
  void event;
};
