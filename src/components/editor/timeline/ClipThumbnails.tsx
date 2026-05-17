import { useClipThumbnails } from '@/hooks/useClipThumbnails';

interface Props {
  assetId: string | null;
  sourceInMs: number;
  sourceOutMs: number;
  widthPx: number;
  heightPx: number;
  isAudio?: boolean;
}

// Roughly one thumbnail per this many CSS pixels of clip width. Mirrors CapCut / Premiere,
// where thumbs are typically ~60-100px wide on the timeline.
const PX_PER_THUMB = 80;

// Don't bother extracting frames for clip blocks that are barely wider than a few pixels —
// they'd render as a smear and just cost IPC calls.
const MIN_WIDTH_TO_RENDER = 20;

/**
 * Horizontal strip of evenly-spaced frame thumbnails for a video clip on the timeline.
 *
 * Rendered as an absolutely-positioned overlay inside a ClipBlock. Pointer events pass
 * through so the parent's drag handlers continue to work.
 */
export function ClipThumbnails({
  assetId,
  sourceInMs,
  sourceOutMs,
  widthPx,
  heightPx,
  isAudio = false,
}: Props): JSX.Element | null {
  // Audio clips already have a Waveform — don't overlay anything on top of them.
  const shouldRender = !isAudio && widthPx >= MIN_WIDTH_TO_RENDER;

  // Compute count regardless of shouldRender so hook order stays stable. When we won't
  // render, we still call the hook with assetId=null which short-circuits to no fetches.
  const count = Math.max(1, Math.floor(widthPx / PX_PER_THUMB));
  const slotWidth = widthPx / count;
  const { urls } = useClipThumbnails(shouldRender ? assetId : null, sourceInMs, sourceOutMs, count);

  if (!shouldRender) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'stretch',
        overflow: 'hidden',
        pointerEvents: 'none',
        borderRadius: 'inherit',
      }}
    >
      {urls.map((url, i) => (
        <div
          key={i}
          style={{
            width: slotWidth,
            height: heightPx,
            flex: '0 0 auto',
            overflow: 'hidden',
            background:
              'linear-gradient(135deg, rgba(0,0,0,0.30), rgba(0,0,0,0.10))',
          }}
        >
          {url ? (
            <img
              src={url}
              alt=""
              draggable={false}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block',
                opacity: 1,
                transition: 'opacity 120ms ease-out',
                userSelect: 'none',
              }}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
