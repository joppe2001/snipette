/**
 * Public entry for the canvas/WebCodecs export pipeline. The UI imports `runWebExport`
 * from here and treats the legacy IPC-based export and this in-renderer export as
 * interchangeable.
 *
 * Currently runs the orchestrator on the main thread. The worker path (./worker.ts) is
 * scaffolded but inactive — pulling FrameSource into a worker requires switching from
 * `<video>` to a `VideoDecoder`-backed source, which is tracked as Phase-3-followup.
 */

export { runOrchestrator as runWebExport } from './orchestrator';
export type {
  WebExportOpts,
  WebExportProgress,
  WebExportResult,
} from './types';

/**
 * Lightweight runtime probe — call this before kicking off an export so the UI can show
 * a useful error if the host's WebCodecs surface is missing pieces.
 */
export function isWebExportAvailable(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined'
  );
}
