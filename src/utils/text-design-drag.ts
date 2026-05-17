import type { TextStyleFull } from '@/utils/text-templates';
import type { TextAnimationSpec } from '@/utils/text-animation';

/**
 * Custom MIME used to identify a Text-Designer drag. Consumers (PreviewCanvas,
 * TrackRow) check for this type on `dragover`/`drop` to gate their text drop
 * handlers — so media file drops never accidentally trigger a text clip.
 */
export const SN_TEXT_DESIGN_MIME = 'application/sn-text-design';

/**
 * Payload serialized into the drag's dataTransfer. Drop handlers parse this
 * back into a partial clip-create spec.
 */
export interface TextDesignDragPayload {
  text: string;
  style: TextStyleFull;
  animation: TextAnimationSpec;
  durationMs: number;
}
