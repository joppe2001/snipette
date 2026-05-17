import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTimelineStore } from '@/store/timeline.store';
import { useTimelineGeometry } from '@/hooks/useTimeline';
import { useEditorStore } from '@/store/editor.store';
import { useProjectStore } from '@/store/project.store';
import { ClipBlock } from './ClipBlock';
import { TransitionMarker, TransitionGapAdd } from './TransitionMarker';
import { makeMarker } from '@/utils/markers';
import { SN_TEXT_DESIGN_MIME, type TextDesignDragPayload } from '@/utils/text-design-drag';
import { DEFAULT_TEXT_ANIM } from '@/utils/text-animation';
import type { ContextMenuItem } from '@/store/editor.store';
import type { MediaAsset, Track } from '@shared/types';

/** Stable key for an ordered-or-not pair of clip ids. Hoisted so it's not re-created
 *  per render. */
function transitionPairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function TrackRowInner({
  track,
  idx,
  height = 42,
  assetsById,
}: {
  track: Track;
  idx: number;
  height?: number;
  /**
   * Asset lookup map, hoisted to Timeline.tsx so it's built once per assets change
   * instead of every ClipBlock running `assets.find(...)` each render. Optional for
   * backward compat — falls back to undefined and ClipBlock will read from its own
   * source as before.
   */
  assetsById?: Map<string, MediaAsset>;
}): JSX.Element {
  // `useShallow` runs the selector + compares the returned array element-by-element.
  // When a sibling track's clip mutates, our subset's items keep the same references
  // → shallow equality holds → this TrackRow doesn't re-render. Was the #1 cascade
  // source per the perf audit.
  const clips = useTimelineStore(
    useShallow((s) => s.clips.filter((c) => c.track_id === track.id)),
  );
  const transitions = useTimelineStore(
    useShallow((s) => s.transitions.filter((t) => t.track_id === track.id)),
  );
  const { xToTime } = useTimelineGeometry();
  const addClip = useTimelineStore((s) => s.addClip);
  const projectId = useTimelineStore((s) => s.projectId);
  const project = useProjectStore((s) => s.activeProject);
  const tracks = useTimelineStore((s) => s.tracks);
  const activeTool = useTimelineStore((s) => s.activeTool);
  const zoomIn = useTimelineStore((s) => s.zoomIn);
  const zoomOut = useTimelineStore((s) => s.zoomOut);
  const computeDuration = useTimelineStore((s) => s.computeDuration);
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const openStickerPicker = useEditorStore((s) => s.openStickerPicker);
  const pushToast = useEditorStore((s) => s.pushToast);
  const setContextMenu = useEditorStore((s) => s.setContextMenu);

  // Stable derived state — only rebuild when the underlying lists change. Without
  // these memos, sorting + Set construction were running on every render trigger.
  const pairsWithTransition = useMemo(
    () => new Set(transitions.map((t) => transitionPairKey(t.clip_a_id, t.clip_b_id))),
    [transitions],
  );
  const sortedClips = useMemo(
    () => [...clips].sort((a, b) => a.start_time_ms - b.start_time_ms),
    [clips],
  );

  // Click on the empty area of a track. Branches by active tool: text → add text, sticker →
  // open picker, zoom → bump zoom centered on click X, otherwise no-op (Hand uses the
  // outer scroll container instead).
  const handleEmptyClick = async (e: React.MouseEvent<HTMLDivElement>) => {
    // Only fire when we click on the row's own div, not on a child clip or transition.
    if (e.target !== e.currentTarget) return;
    if (!project || !projectId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickMs = Math.max(0, xToTime(e.clientX - rect.left));

    if (activeTool === 'text') {
      const targetTrack = track.type === 'text' ? track : tracks.find((t) => t.type === 'text');
      if (!targetTrack) {
        pushToast({ kind: 'info', message: 'Add a text track first.' });
        return;
      }
      const dur = 2000;
      pushHistory();
      const created = await window.snipette.timeline.addClip(targetTrack.id, {
        track_id: targetTrack.id,
        project_id: projectId,
        start_time_ms: clickMs,
        duration_ms: dur,
        source_in_ms: 0,
        source_out_ms: dur,
        text_content: 'Text',
        text_style_json: JSON.stringify({
          font_family: 'Barlow Condensed',
          font_size: 64,
          color: '#FFFFFF',
          stroke_color: '#0A0A0C',
          stroke_width: 2,
        }),
      });
      addClip(created);
      useTimelineStore.getState().selectClip(created.id);
      computeDuration();
      pushToast({ kind: 'success', message: 'Text added — edit in the right panel.' });
      return;
    }

    if (activeTool === 'sticker') {
      openStickerPicker({ x: e.clientX, y: e.clientY, atTimeMs: clickMs });
      return;
    }

    if (activeTool === 'zoom') {
      if (e.altKey) zoomOut();
      else zoomIn();
      return;
    }
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only fire when right-clicking the empty area of the row — ClipBlock / TransitionMarker
    // open their own menus and stopPropagation, so child events never reach here.
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const ms = Math.max(0, xToTime(e.clientX - rect.left));
    const trackClipIds = clips.map((c) => c.id);
    const items: ContextMenuItem[] = [
      { kind: 'header', label: `${track.type} · ${track.name}` },
      {
        label: 'Add marker here',
        hint: 'M',
        onClick: () => useTimelineStore.getState().addMarker(makeMarker(ms)),
      },
      {
        label: 'Set playhead here',
        onClick: () => useTimelineStore.getState().setPlayhead(ms),
      },
      { kind: 'separator' },
      {
        label: `Select all clips on this track${trackClipIds.length ? ` (${trackClipIds.length})` : ''}`,
        disabled: trackClipIds.length === 0,
        onClick: () => {
          useTimelineStore.setState({
            selectedClipIds: trackClipIds,
            selectedTrackId: null,
            selectedTransitionId: null,
            selectedMarkerIds: [],
          });
        },
      },
    ];
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const cursorByTool: Record<typeof activeTool, string> = {
    select: 'default',
    razor: 'crosshair',
    text: 'text',
    sticker: 'copy',
    hand: 'grab',
    zoom: 'zoom-in',
  };

  /**
   * Text-Designer drop on a TrackRow. Reads the SN_TEXT_DESIGN_MIME payload,
   * resolves the drop X to a timeline time via `xToTime`, and creates a text
   * clip at that time on this track if it's a text track — otherwise falls
   * back to the first text track on the timeline. Mirrors the canvas-drop
   * pattern in PreviewCanvas so both flows produce the same shape of clip.
   */
  const handleTextDesignDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    if (!project || !projectId) return;
    const raw = e.dataTransfer.getData(SN_TEXT_DESIGN_MIME);
    if (!raw) return;
    let payload: TextDesignDragPayload;
    try {
      payload = JSON.parse(raw) as TextDesignDragPayload;
    } catch {
      return;
    }
    const targetTrack = track.type === 'text' ? track : tracks.find((t) => t.type === 'text');
    if (!targetTrack) {
      pushToast({ kind: 'error', message: 'Add a text track first.' });
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const dropMs = Math.max(0, xToTime(e.clientX - rect.left));
    pushHistory();
    try {
      const created = await window.snipette.timeline.addClip(targetTrack.id, {
        track_id: targetTrack.id,
        project_id: projectId,
        start_time_ms: dropMs,
        duration_ms: payload.durationMs,
        source_in_ms: 0,
        source_out_ms: payload.durationMs,
        text_content: payload.text,
        text_style_json: JSON.stringify(payload.style),
      });
      const positioned = await window.snipette.timeline.updateClip(created.id, {
        text_animation_json: JSON.stringify({ ...DEFAULT_TEXT_ANIM, ...payload.animation }),
      });
      addClip(positioned);
      useTimelineStore.getState().selectClip(positioned.id);
      computeDuration();
      pushToast({ kind: 'success', message: 'Text placed on track.' });
    } catch (err) {
      pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not place text.',
      });
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: idx * height + 24, // 24 for ruler
        height,
        borderBottom: '1px solid var(--border-subtle)',
        cursor: cursorByTool[activeTool],
      }}
      onClick={handleEmptyClick}
      onContextMenu={handleContextMenu}
      onDragOver={(e) => {
        // Only intercept our own text-design drag — media-library file drops
        // and clip-move drags must NOT be hijacked by this handler.
        if (!e.dataTransfer.types.includes(SN_TEXT_DESIGN_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(SN_TEXT_DESIGN_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        void handleTextDesignDrop(e);
      }}
    >
      {clips.map((c) => (
        <ClipBlock
          key={c.id}
          clip={c}
          track={track}
          asset={c.asset_id ? assetsById?.get(c.asset_id) ?? null : null}
        />
      ))}

      {/* Transition markers — render after clips so they sit on top. Transitions on
          this track always reference clips on this track, so the locally-scoped
          `clips` (filtered subset) is sufficient. */}
      {transitions.map((tr) => {
        const a = clips.find((c) => c.id === tr.clip_a_id);
        const b = clips.find((c) => c.id === tr.clip_b_id);
        if (!a || !b) return null;
        return <TransitionMarker key={tr.id} transition={tr} clipA={a} clipB={b} />;
      })}

      {/* Inline "+" gap-add icons between adjacent clips that don't already have a transition. */}
      {projectId &&
        sortedClips.map((a, i) => {
          const b = sortedClips[i + 1];
          if (!b) return null;
          if (pairsWithTransition.has(transitionPairKey(a.id, b.id))) return null;
          return (
            <TransitionGapAdd key={`gap-${a.id}-${b.id}`} clipA={a} clipB={b} trackId={track.id} projectId={projectId} />
          );
        })}
    </div>
  );
}

/** Memoized export — TrackRow's props (track, idx, height) are stable across most
 *  parent re-renders, so wrapping in memo lets sibling-track mutations skip this
 *  TrackRow entirely. */
export const TrackRow = memo(TrackRowInner);
