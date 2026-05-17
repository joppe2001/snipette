import { memo, useMemo, useRef, useState } from 'react';
import { useTimelineGeometry } from '@/hooks/useTimeline';
import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import { Waveform } from './Waveform';
import { ClipThumbnails } from './ClipThumbnails';
import type { Clip, ColorGrade, MediaAsset, Track } from '@shared/types';
import { Icons } from '@/components/ui/icons';
import {
  clearKeyframesFromEffects,
  clearMotionEffectsFromEffects,
  computeRippleDelete,
  computeSlip,
  freezeFrameAt,
} from '@/utils/timeline-edits';
import { stopEdgeScroll, updateEdgeScroll } from '@/utils/edge-scroll';
import {
  audioFxOnly,
  isAudioFxType,
  parseEffectsArray,
  type RawEffectEntry,
} from '@/utils/audio-fx';
import { parseKeyframes } from '@/utils/keyframes';

interface Props {
  clip: Clip;
  track: Track;
  /**
   * Asset for this clip's `asset_id`, looked up once in Timeline.tsx and passed in.
   * Avoids running `assets.find(...)` inside every ClipBlock on every render.
   * `null` when the clip has no asset (text / sticker clips) or the asset isn't in
   * the library yet.
   */
  asset: MediaAsset | null;
}

type DragMode = 'move' | 'trim-left' | 'trim-right' | 'slip' | null;

function ClipBlockInner({ clip, track, asset }: Props): JSX.Element {
  const { timeToX, xToTime, snapTime } = useTimelineGeometry();
  const selected = useTimelineStore((s) => s.selectedClipIds.includes(clip.id));
  const selectClip = useTimelineStore((s) => s.selectClip);
  const updateLocal = useTimelineStore((s) => s.updateClipLocal);
  const replaceClip = useTimelineStore((s) => s.replaceClip);
  const removeClip = useTimelineStore((s) => s.removeClip);
  const addClip = useTimelineStore((s) => s.addClip);
  const activeTool = useTimelineStore((s) => s.activeTool);
  // Note: `playheadMs` and `tracks` are deliberately NOT subscribed here. They are
  // read on-demand via `useTimelineStore.getState()` inside pointer / context-menu
  // handlers. Subscribing would re-render every ClipBlock on each playhead tick
  // (60Hz) and on any track edit, even though the values are only used in handlers.
  const setContextMenu = useEditorStore((s) => s.setContextMenu);

  // Same constants the Timeline component uses; kept in sync if those ever change.
  const TRACK_HEIGHT = 42;
  const RULER_HEIGHT = 24;

  // Keep the timeline body element + most-recent pointer position around for the
  // auto-scroll tick callback. Without them, scroll changes happening while the mouse
  // is held still would not update the dragged clip's time, so it would visibly fall
  // behind the cursor.
  const dragBodyRef = useRef<HTMLElement | null>(null);
  const latestClientX = useRef<number>(0);
  const latestClientY = useRef<number>(0);

  const dragState = useRef<{
    mode: DragMode;
    startClientX: number;
    startClientY: number;
    /** body.scrollLeft at the moment the drag started — used to keep delta math
     *  scroll-aware so auto-scroll keeps the clip glued to the cursor's TIME. */
    startScrollLeft: number;
    origStart: number;
    origDuration: number;
    origSourceIn: number;
    origSourceOut: number;
    origTrackId: string;
  } | null>(null);

  const [localStart, setLocalStart] = useState(clip.start_time_ms);
  const [localDuration, setLocalDuration] = useState(clip.duration_ms);
  const [localSourceIn, setLocalSourceIn] = useState(clip.source_in_ms);
  const [localSourceOut, setLocalSourceOut] = useState(clip.source_out_ms);
  const [localTrackId, setLocalTrackId] = useState(clip.track_id);
  const [altOver, setAltOver] = useState(false);
  const [slipping, setSlipping] = useState(false);

  // Derive width through the memoized geometry path so it reacts to zoom changes
  // via the same callback identity the rest of the component already depends on,
  // rather than reading zoomLevel imperatively on every render.
  const renderStart = dragState.current ? localStart : clip.start_time_ms;
  const renderDuration = dragState.current ? localDuration : clip.duration_ms;
  const x = timeToX(renderStart);
  const w = Math.max(8, timeToX(renderStart + renderDuration) - x);

  // While dragging across tracks, the clip stays mounted on the original track row — so we offset
  // its top by the row-delta so it visually lands on the destination row. Reading `tracks` from
  // getState() here (instead of subscribing) is safe because this branch only runs while a
  // pointer drag is active, and any pointermove will trigger a re-render via setLocalTrackId.
  let dragYOffset = 0;
  if (dragState.current && localTrackId !== clip.track_id) {
    const allTracks = useTimelineStore.getState().tracks;
    const fromIdx = allTracks.findIndex((t) => t.id === clip.track_id);
    const toIdx = allTracks.findIndex((t) => t.id === localTrackId);
    if (fromIdx >= 0 && toIdx >= 0) dragYOffset = (toIdx - fromIdx) * TRACK_HEIGHT;
  }

  const trackColor = track.color;

  const handlePointerDown = (mode: DragMode) => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (activeTool === 'razor' && mode === 'move') {
      // Split at clicked position
      const rect = (e.currentTarget.closest('.sn-timeline-body') as HTMLDivElement | null)?.getBoundingClientRect();
      const offsetX = rect ? e.clientX - rect.left : e.clientX;
      const splitMs = xToTime(offsetX);
      void window.snipette.timeline.splitClip(clip.id, splitMs).then(([left, right]) => {
        replaceClip(left);
        addClip(right);
      });
      return;
    }
    // Alt + press on the clip body → slip edit (NLE convention). Trim handles are unaffected.
    const effectiveMode: DragMode = mode === 'move' && e.altKey ? 'slip' : mode;
    selectClip(clip.id, e.shiftKey);
    (e.target as Element).setPointerCapture(e.pointerId);
    // Snapshot before any drag mutation so undo restores the pre-drag position.
    useTimelineStore.getState().pushHistory();
    setSlipping(effectiveMode === 'slip');
    const body = (e.target as Element).closest('.sn-timeline-body') as HTMLElement | null;
    dragBodyRef.current = body;
    latestClientX.current = e.clientX;
    latestClientY.current = e.clientY;
    dragState.current = {
      mode: effectiveMode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startScrollLeft: body?.scrollLeft ?? 0,
      origStart: clip.start_time_ms,
      origDuration: clip.duration_ms,
      origSourceIn: clip.source_in_ms,
      origSourceOut: clip.source_out_ms,
      origTrackId: clip.track_id,
    };
    setLocalStart(clip.start_time_ms);
    setLocalDuration(clip.duration_ms);
    setLocalSourceIn(clip.source_in_ms);
    setLocalSourceOut(clip.source_out_ms);
    setLocalTrackId(clip.track_id);
  };

  /**
   * Run the drag math using a given pointer position. Extracted from handlePointerMove
   * so the auto-scroll rAF can keep calling it (with the cached pointer position) as the
   * timeline scrolls beneath a held pointer. Without this hook, scroll-driven moves
   * would not update the clip and it would fall behind the cursor.
   */
  const applyDrag = (clientX: number, clientY: number): void => {
    const drag = dragState.current;
    if (!drag) return;
    const body = dragBodyRef.current;
    const currentScrollLeft = body?.scrollLeft ?? 0;
    // Scroll-aware delta: include how much the timeline has scrolled since drag start.
    // This is what makes a clip stay glued to the cursor while the view auto-scrolls.
    const totalDeltaPx = clientX - drag.startClientX + (currentScrollLeft - drag.startScrollLeft);
    const zoomNow = useTimelineStore.getState().zoomLevel;
    const deltaMs = (totalDeltaPx / zoomNow) * 1000;
    if (drag.mode === 'move') {
      // Snap BOTH edges of the dragged clip. Try snapping the start, and try
      // snapping the end (start + duration). A snap occurred for an edge if
      // snapTime returned a DIFFERENT value than the raw input. Pick whichever
      // edge produced a snap (or the smaller correction if both did). Without
      // this, dragging clip-A's right edge toward clip-B's left edge never
      // snaps because only the clip's start position was being checked.
      const rawStart = drag.origStart + deltaMs;
      const dur = drag.origDuration;
      const rawEnd = rawStart + dur;
      const snappedStart = snapTime(rawStart, clip.id);
      const snappedEnd = snapTime(rawEnd, clip.id);
      const startCorrection = Math.abs(snappedStart - rawStart);
      const endCorrection = Math.abs(snappedEnd - rawEnd);
      const startSnapped = startCorrection > 0;
      const endSnapped = endCorrection > 0;
      let chosen = rawStart;
      if (startSnapped && endSnapped) {
        // Both edges found a snap — prefer the one closer to its raw position.
        chosen = startCorrection <= endCorrection ? snappedStart : snappedEnd - dur;
      } else if (startSnapped) {
        chosen = snappedStart;
      } else if (endSnapped) {
        chosen = snappedEnd - dur;
      }
      const next = Math.max(0, chosen);
      setLocalStart(next);
      // Cross-track move: pick the track row under the cursor, but only allow it if its kind
      // matches this clip's current track (video → video, audio → audio, etc.) so a video
      // doesn't end up on an audio lane.
      if (body) {
        const rect = body.getBoundingClientRect();
        const y = clientY - rect.top + body.scrollTop;
        const idx = Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
        // Read tracks via getState() to avoid subscribing — pointer-driven re-renders
        // happen via setLocalTrackId / setLocalStart already.
        const allTracks = useTimelineStore.getState().tracks;
        const target = allTracks[idx];
        if (target && target.type === track.type && target.is_locked === 0 && target.id !== localTrackId) {
          setLocalTrackId(target.id);
        }
      }
    } else if (drag.mode === 'trim-left') {
      const speed = Math.max(0.05, clip.speed);
      // Text/sticker clips (no asset) and images have no real source duration to
      // bound against — they can stretch freely. Video/audio is bounded by the
      // file's actual length.
      const isStretchable = !asset || asset.type === 'image';
      // Min source-in is 0 (start of file). Translate into a minimum `movedBy` for
      // the left edge so a leftward drag stops at the natural file start.
      const minMovedBy = isStretchable ? -Infinity : -drag.origSourceIn / speed;
      const proposedStart = Math.max(0, snapTime(drag.origStart + deltaMs, clip.id));
      let movedBy = proposedStart - drag.origStart;
      if (movedBy < minMovedBy) movedBy = minMovedBy;
      const actualStart = drag.origStart + movedBy;
      const proposedDuration = drag.origDuration - movedBy;
      if (proposedDuration > 100) {
        setLocalStart(actualStart);
        setLocalDuration(proposedDuration);
        setLocalSourceIn(drag.origSourceIn + movedBy * speed);
      }
    } else if (drag.mode === 'trim-right') {
      const speed = Math.max(0.05, clip.speed);
      const isStretchable = !asset || asset.type === 'image';
      // Max duration is whatever source remains after source_in_ms, scaled by speed —
      // i.e. slowmo (speed < 1) legitimately extends the maximum clip length, and
      // fast-forward (speed > 1) shortens it. Stretchable assets are unbounded.
      const sourceDur = isStretchable
        ? Number.POSITIVE_INFINITY
        : asset.duration_ms ?? Number.POSITIVE_INFINITY;
      const maxDuration = (sourceDur - drag.origSourceIn) / speed;
      // Snap the END position (start + duration) to other clips' edges, not the
      // duration itself. Then derive duration from the snapped end.
      const proposedEnd = snapTime(drag.origStart + drag.origDuration + deltaMs, clip.id);
      const snappedDuration = proposedEnd - drag.origStart;
      const proposed = Math.max(100, Math.min(maxDuration, snappedDuration));
      setLocalDuration(proposed);
      setLocalSourceOut(drag.origSourceIn + proposed * speed);
    } else if (drag.mode === 'slip') {
      // Slip: keep start/duration/track fixed; shift the source window by deltaMs (clamped).
      const sourceDur = asset?.duration_ms ?? Math.max(clip.source_out_ms, clip.duration_ms);
      const speed = clip.speed || 1;
      const baseClip: Clip = {
        ...clip,
        source_in_ms: drag.origSourceIn,
        source_out_ms: drag.origSourceOut,
      };
      const slip = computeSlip(baseClip, deltaMs * speed, sourceDur);
      setLocalSourceIn(slip.source_in_ms);
      setLocalSourceOut(slip.source_out_ms);
    }
  };

  /**
   * Real pointer-move handler: updates the cached cursor position, runs the drag math,
   * and asks the edge-scroll util whether the cursor is near a viewport edge. When it
   * is, the util ticks scroll forward each rAF and calls back into applyDrag so the
   * clip's time keeps tracking the cursor while the timeline glides past underneath.
   */
  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragState.current;
    if (!drag) return;
    latestClientX.current = e.clientX;
    latestClientY.current = e.clientY;
    applyDrag(e.clientX, e.clientY);
    const body = dragBodyRef.current;
    if (body) {
      updateEdgeScroll(body, e.clientX, () => {
        applyDrag(latestClientX.current, latestClientY.current);
      });
    }
  };

  // Hover-only alt detection: surfaces the slip cursor before any drag begins so users
  // know the option is available. Not load-bearing — drag-start re-checks e.altKey.
  const handleBodyPointerMoveHover = (e: React.PointerEvent) => {
    if (!dragState.current) setAltOver(e.altKey);
    handlePointerMove(e);
  };

  const handleBodyPointerLeave = () => {
    if (!dragState.current) setAltOver(false);
  };

  const handlePointerUp = async () => {
    const drag = dragState.current;
    if (!drag) return;
    dragState.current = null;
    stopEdgeScroll();
    dragBodyRef.current = null;
    // Slip preserves position/track/duration — only source window changes.
    const updates: Partial<Clip> =
      drag.mode === 'slip'
        ? {
            source_in_ms: localSourceIn,
            source_out_ms: localSourceOut,
          }
        : {
            start_time_ms: localStart,
            duration_ms: localDuration,
            source_in_ms: localSourceIn,
            source_out_ms: localSourceOut,
            track_id: localTrackId,
          };
    updateLocal(clip.id, updates);
    try {
      const updated = await window.snipette.timeline.updateClip(clip.id, updates);
      replaceClip(updated);
    } catch {
      // Roll back on failure
      updateLocal(clip.id, {
        start_time_ms: drag.origStart,
        duration_ms: drag.origDuration,
        source_in_ms: drag.origSourceIn,
        source_out_ms: drag.origSourceOut,
        track_id: drag.origTrackId,
      });
      setLocalTrackId(drag.origTrackId);
    }
    setSlipping(false);
    useTimelineStore.getState().computeDuration();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Read playhead lazily — the menu is built imperatively on right-click and
    // closed after a single action, so a fresh getState() read is fine and avoids
    // a 60Hz subscription that would re-render every ClipBlock on every tick.
    const playheadMs = useTimelineStore.getState().playheadMs;

    // Helper: persist a partial update to a clip via IPC + local store. Snapshots history
    // first so each menu action is a single undo step.
    const applyUpdate = async (updates: Partial<Clip>): Promise<void> => {
      useTimelineStore.getState().pushHistory();
      updateLocal(clip.id, updates);
      try {
        const updated = await window.snipette.timeline.updateClip(clip.id, updates);
        replaceClip(updated);
      } catch {
        // Roll back local optimistic update on IPC failure. The pre-history snapshot
        // still gives the user an explicit undo path if they want to back out.
        updateLocal(clip.id, {
          is_reversed: clip.is_reversed,
          speed: clip.speed,
          position_x: clip.position_x,
          position_y: clip.position_y,
          scale_x: clip.scale_x,
          scale_y: clip.scale_y,
          rotation: clip.rotation,
          effects_json: clip.effects_json,
        });
      }
    };

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { kind: 'header', label: 'Clip' },
        { kind: 'separator' },
        {
          label: 'Split at playhead',
          hint: 'B',
          onClick: async () => {
            if (playheadMs <= clip.start_time_ms || playheadMs >= clip.start_time_ms + clip.duration_ms) return;
            const [left, right] = await window.snipette.timeline.splitClip(clip.id, playheadMs);
            replaceClip(left);
            addClip(right);
          },
        },
        {
          label: 'Duplicate',
          hint: '⌘D',
          onClick: async () => {
            const dup = await window.snipette.timeline.addClip(clip.track_id, {
              track_id: clip.track_id,
              project_id: clip.project_id,
              asset_id: clip.asset_id ?? undefined,
              start_time_ms: clip.start_time_ms + clip.duration_ms,
              duration_ms: clip.duration_ms,
              source_in_ms: clip.source_in_ms,
              source_out_ms: clip.source_out_ms,
              text_content: clip.text_content ?? undefined,
            });
            addClip(dup);
          },
        },
        {
          label: 'Reverse clip',
          onClick: () => {
            void applyUpdate({ is_reversed: clip.is_reversed ? 0 : 1 });
          },
        },
        // Speed picker: ContextMenu.tsx doesn't support nested submenus yet, so we inline.
        {
          label: `Speed: 0.5×${clip.speed === 0.5 ? '  ✓' : ''}`,
          onClick: () => {
            void applyUpdate({ speed: 0.5 });
          },
        },
        {
          label: `Speed: 1×${clip.speed === 1 ? '  ✓' : ''}`,
          onClick: () => {
            void applyUpdate({ speed: 1 });
          },
        },
        {
          label: `Speed: 2×${clip.speed === 2 ? '  ✓' : ''}`,
          onClick: () => {
            void applyUpdate({ speed: 2 });
          },
        },
        {
          label: 'Freeze frame (1s)',
          // Freeze only makes sense when the playhead is inside the clip — otherwise the
          // split would no-op or fail. Disable with an explanatory tooltip when it's not.
          disabled:
            playheadMs <= clip.start_time_ms ||
            playheadMs >= clip.start_time_ms + clip.duration_ms,
          onClick: () => {
            void freezeFrameAt(clip.id, playheadMs, 1000);
          },
        },
        { kind: 'separator' },
        {
          label: 'Reset transform',
          onClick: () => {
            void applyUpdate({
              position_x: 0,
              position_y: 0,
              scale_x: 1,
              scale_y: 1,
              rotation: 0,
            });
          },
        },
        {
          label: 'Clear keyframes',
          onClick: () => {
            void applyUpdate({ effects_json: clearKeyframesFromEffects(clip.effects_json) });
          },
        },
        {
          label: 'Clear effects',
          onClick: () => {
            void applyUpdate({
              effects_json: clearMotionEffectsFromEffects(clip.effects_json),
            });
          },
        },
        { kind: 'separator' },
        {
          label: 'Ripple delete',
          hint: '⌥⌫',
          danger: true,
          onClick: async () => {
            const all = useTimelineStore.getState().clips;
            const result = computeRippleDelete(all, [clip.id]);
            useTimelineStore.getState().pushHistory();
            // Delete then shift. Order matters so the deleted clip doesn't briefly appear
            // alongside the shifted neighbours.
            for (const id of result.toDelete) {
              try {
                await window.snipette.timeline.deleteClip(id);
                removeClip(id);
              } catch {
                // Ignore individual delete failures — better to apply partial ripple than
                // leave the user with a half-applied gap close.
              }
            }
            for (const shift of result.toShift) {
              try {
                const updated = await window.snipette.timeline.updateClip(shift.id, {
                  start_time_ms: shift.new_start_ms,
                });
                replaceClip(updated);
              } catch {
                // Skip failed shifts; the clip stays at its pre-ripple start.
              }
            }
            useTimelineStore.getState().computeDuration();
          },
        },
        {
          label: 'Delete',
          danger: true,
          hint: '⌫',
          onClick: async () => {
            await window.snipette.timeline.deleteClip(clip.id);
            removeClip(clip.id);
            useTimelineStore.getState().computeDuration();
          },
        },
      ],
    });
  };

  const slipDelta = slipping ? localSourceIn - clip.source_in_ms : 0;
  const cursor = activeTool === 'razor'
    ? 'crosshair'
    : slipping || altOver
      ? 'ew-resize'
      : 'grab';

  return (
    <div
      className={`sn-clip ${selected ? 'selected' : ''}`}
      onPointerDown={handlePointerDown('move')}
      onPointerMove={handleBodyPointerMoveHover}
      onPointerUp={handlePointerUp}
      onPointerLeave={handleBodyPointerLeave}
      onContextMenu={handleContextMenu}
      onDoubleClick={() => {
        if (track.type === 'text') {
          const next = prompt('Text', clip.text_content ?? '');
          if (next !== null) {
            updateLocal(clip.id, { text_content: next });
            void window.snipette.timeline.updateClip(clip.id, { text_content: next });
          }
        }
      }}
      style={{
        left: x,
        width: w,
        transform: dragYOffset ? `translateY(${dragYOffset}px)` : undefined,
        background: trackColor,
        cursor,
        zIndex: dragState.current ? 3 : undefined,
      }}
    >
      {track.type === 'audio' && (
        <Waveform
          assetId={clip.asset_id}
          width={w}
          height={34}
          muted={track.is_muted === 1}
          sourceInMs={clip.source_in_ms}
          sourceOutMs={clip.source_out_ms}
          totalDurationMs={asset?.duration_ms ?? clip.duration_ms}
        />
      )}
      {track.type === 'video' && (
        <ClipThumbnails
          assetId={clip.asset_id}
          sourceInMs={dragState.current ? localSourceIn : clip.source_in_ms}
          sourceOutMs={dragState.current ? localSourceOut : clip.source_out_ms}
          widthPx={w}
          heightPx={34}
        />
      )}
      {track.type === 'text' && <Icons.TextT size={10} />}
      <span
        style={{
          position: 'relative',
          fontSize: 10,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          color: track.type === 'video' ? '#fff' : '#0A0A0C',
          textShadow: track.type === 'video' ? '0 1px 2px rgba(0,0,0,0.6)' : 'none',
          marginLeft: track.type === 'text' ? 4 : 0,
        }}
      >
        {clip.text_content ?? asset?.original_path.split(/[\\/]/).pop() ?? track.name}
      </span>
      <ClipFxBadges clip={clip} clipWidthPx={w} darkText={track.type !== 'video'} />
      {/* trim handles */}
      <div
        onPointerDown={handlePointerDown('trim-left')}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: 6,
          cursor: 'ew-resize',
          background: 'rgba(0,0,0,0.2)',
        }}
      />
      <div
        onPointerDown={handlePointerDown('trim-right')}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          right: 0,
          width: 6,
          cursor: 'ew-resize',
          background: 'rgba(0,0,0,0.2)',
        }}
      />
      {slipping && (
        <div
          style={{
            position: 'absolute',
            top: -18,
            left: '50%',
            transform: 'translateX(-50%)',
            fontSize: 10,
            fontWeight: 600,
            padding: '2px 6px',
            borderRadius: 4,
            background: 'rgba(0,0,0,0.78)',
            color: '#fff',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 4,
          }}
        >
          {`Slip: ${slipDelta > 0 ? '+' : ''}${Math.round(slipDelta)} ms`}
        </div>
      )}
    </div>
  );
}

/**
 * Default-shallow memo wrapper. The zustand `clips` mutator preserves references for
 * untouched clips, so a single clip's drag/keyframe/effects change won't re-render
 * its sibling ClipBlocks anymore. Big timeline-with-many-clips win.
 */
export const ClipBlock = memo(ClipBlockInner);

// ---------------------------------------------------------------------------
// FX badges: tiny labelled chips that surface which filters/effects/adjustments
// are active on a clip. Helps you scan the timeline and instantly see "this
// clip has color grade + a motion FX", without opening the inspector.
// ---------------------------------------------------------------------------

interface FxBadge {
  key: string;
  label: string;
  tooltip: string;
  color: string;
}

function hasNonDefaultGrade(json: string | null): boolean {
  if (!json) return false;
  try {
    const g = JSON.parse(json) as Partial<ColorGrade>;
    if (g.lut_path) return true;
    const keys: (keyof ColorGrade)[] = [
      'exposure',
      'contrast',
      'saturation',
      'temperature',
      'tint',
      'highlights',
      'shadows',
      'whites',
      'blacks',
      'vibrance',
      'sharpness',
      'vignette',
    ];
    return keys.some((k) => {
      const v = g[k];
      return typeof v === 'number' && Math.abs(v) > 0.0001;
    });
  } catch {
    return false;
  }
}

function ClipFxBadges({
  clip,
  clipWidthPx,
  darkText,
}: {
  clip: Clip;
  clipWidthPx: number;
  darkText: boolean;
}): JSX.Element | null {
  const badges = useMemo<FxBadge[]>(() => {
    const out: FxBadge[] = [];

    const entries: RawEffectEntry[] = parseEffectsArray(clip.effects_json);
    const filterPreset = entries.find((e) => e.type === 'filter-preset');
    if (filterPreset?.name) {
      // User picked a named filter from the Filters tab — show its actual name.
      out.push({
        key: 'filter',
        label: filterPreset.name,
        tooltip: `Filter: ${filterPreset.name}`,
        color: '#F2A83A',
      });
    } else if (hasNonDefaultGrade(clip.color_grade_json)) {
      // Manual color-grade tweak without a preset; fall back to a generic chip.
      out.push({ key: 'grade', label: 'CG', tooltip: 'Color grade', color: '#F2A83A' });
    }

    const motionFx = entries.filter(
      (e) =>
        !isAudioFxType(e.type) &&
        e.type !== 'keyframes' &&
        e.type !== 'audio-normalize' &&
        e.type !== 'audio-duck-source' &&
        e.type !== 'audio-duck-target' &&
        e.type !== 'filter-preset',
    );
    const audioFx = audioFxOnly(entries).filter((f) => !f.bypassed);
    const kf = parseKeyframes(clip.effects_json);
    const hasKf = Object.keys(kf).length > 0;
    const hasNormalize = entries.some((e) => e.type === 'audio-normalize');
    const hasDuckSource = entries.some((e) => e.type === 'audio-duck-source');
    const hasDuckTarget = entries.some((e) => e.type === 'audio-duck-target');

    if (motionFx.length > 0) {
      out.push({
        key: 'mfx',
        label: motionFx.length > 1 ? `FX×${motionFx.length}` : 'FX',
        tooltip: `Motion FX (${motionFx.length})`,
        color: '#9C3AF2',
      });
    }
    if (audioFx.length > 0) {
      out.push({
        key: 'afx',
        label: audioFx.length > 1 ? `A×${audioFx.length}` : 'A',
        tooltip: `Audio FX (${audioFx.length})`,
        color: '#3AC8F2',
      });
    }
    if (hasKf) {
      out.push({ key: 'kf', label: 'KF', tooltip: 'Keyframes', color: '#C8F23A' });
    }
    if (hasNormalize) {
      out.push({ key: 'ln', label: 'LN', tooltip: 'Loudness normalize', color: '#3AF26E' });
    }
    if (hasDuckSource) {
      out.push({ key: 'duck-src', label: 'D→', tooltip: 'Auto-duck source', color: '#F23A5E' });
    }
    if (hasDuckTarget) {
      out.push({ key: 'duck-tgt', label: '→D', tooltip: 'Auto-duck target', color: '#F23A5E' });
    }
    if (clip.speed !== 1) {
      out.push({
        key: 'spd',
        label: `${clip.speed >= 1 ? clip.speed.toFixed(1).replace(/\.0$/, '') : clip.speed.toFixed(2)}×`,
        tooltip: `Speed ${clip.speed.toFixed(2)}×`,
        color: '#F23AC8',
      });
    }
    if (clip.is_reversed) {
      out.push({ key: 'rev', label: '↺', tooltip: 'Reversed', color: '#FFE03A' });
    }

    return out;
  }, [clip.color_grade_json, clip.effects_json, clip.speed, clip.is_reversed]);

  if (badges.length === 0) return null;
  // Narrow clips can't fit many badges. Trim from the right and append a "+N" overflow
  // chip so the user still knows there's more than what's visible.
  const maxBadges = Math.max(1, Math.floor((clipWidthPx - 16) / 26));
  const visible = badges.slice(0, maxBadges);
  const overflow = badges.length - visible.length;

  return (
    <div
      style={{
        position: 'absolute',
        top: 2,
        right: 4,
        display: 'flex',
        gap: 2,
        pointerEvents: 'none',
        zIndex: 2,
      }}
    >
      {visible.map((b) => (
        <span
          key={b.key}
          title={b.tooltip}
          style={{
            fontSize: 8.5,
            fontWeight: 700,
            padding: '1px 4px',
            background: darkText ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.72)',
            color: b.color,
            borderRadius: 3,
            border: `0.5px solid ${b.color}80`,
            letterSpacing: 0.4,
            lineHeight: '12px',
            fontFamily: 'var(--font-mono, ui-monospace)',
          }}
        >
          {b.label}
        </span>
      ))}
      {overflow > 0 && (
        <span
          title={badges
            .slice(maxBadges)
            .map((b) => b.tooltip)
            .join(' · ')}
          style={{
            fontSize: 8.5,
            fontWeight: 700,
            padding: '1px 4px',
            background: darkText ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.72)',
            color: 'var(--text-secondary, #C0C0C0)',
            borderRadius: 3,
            letterSpacing: 0.4,
            lineHeight: '12px',
            fontFamily: 'var(--font-mono, ui-monospace)',
          }}
        >
          {`+${overflow}`}
        </span>
      )}
    </div>
  );
}
