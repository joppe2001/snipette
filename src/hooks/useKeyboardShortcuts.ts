import { useEffect } from 'react';
import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import { useProjectStore } from '@/store/project.store';
import { makeMarker } from '@/utils/markers';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

function isMod(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** Nudge every selected clip by `frames` frames. Mutates store + persists via IPC. */
function nudgeSelectedClipsFrames(frames: number, fps: number): void {
  const tStore = useTimelineStore.getState();
  if (tStore.selectedClipIds.length === 0) return;
  const dt = Math.round((1000 / fps) * frames);
  if (dt === 0) return;
  tStore.pushHistory();
  for (const id of tStore.selectedClipIds) {
    const clip = tStore.clips.find((c) => c.id === id);
    if (!clip) continue;
    const nextStart = Math.max(0, clip.start_time_ms + dt);
    tStore.updateClipLocal(id, { start_time_ms: nextStart });
    void window.snipette.timeline.updateClip(id, { start_time_ms: nextStart }).catch(() => {});
  }
  tStore.computeDuration();
}

/** Split selected clips at current playhead. Mirrors ClipBlock's "Split at playhead". */
function splitSelectedAtPlayhead(): void {
  const tStore = useTimelineStore.getState();
  if (tStore.selectedClipIds.length === 0) return;
  const playheadMs = tStore.playheadMs;
  const targets = tStore.clips.filter(
    (c) =>
      tStore.selectedClipIds.includes(c.id) &&
      playheadMs > c.start_time_ms &&
      playheadMs < c.start_time_ms + c.duration_ms,
  );
  if (targets.length === 0) return;
  tStore.pushHistory();
  for (const clip of targets) {
    void window.snipette.timeline
      .splitClip(clip.id, playheadMs)
      .then(([left, right]) => {
        tStore.replaceClip(left);
        tStore.addClip(right);
      })
      .catch(() => {});
  }
}

/** Move selected clips to the adjacent track (above/below) of the same kind. */
function moveSelectedClipsToAdjacentTrack(direction: 'up' | 'down'): void {
  const tStore = useTimelineStore.getState();
  if (tStore.selectedClipIds.length === 0) return;
  const sortedTracks = [...tStore.tracks].sort((a, b) => a.order_index - b.order_index);
  const moves: { id: string; new_track_id: string }[] = [];
  for (const id of tStore.selectedClipIds) {
    const clip = tStore.clips.find((c) => c.id === id);
    if (!clip) continue;
    const curIdx = sortedTracks.findIndex((t) => t.id === clip.track_id);
    if (curIdx < 0) continue;
    const curTrack = sortedTracks[curIdx];
    // Direction "up" = lower order_index. "down" = higher order_index.
    const range =
      direction === 'up'
        ? sortedTracks.slice(0, curIdx).reverse()
        : sortedTracks.slice(curIdx + 1);
    const target = range.find((t) => t.type === curTrack.type);
    if (target) moves.push({ id, new_track_id: target.id });
  }
  if (moves.length === 0) return;
  tStore.pushHistory();
  for (const m of moves) {
    tStore.updateClipLocal(m.id, { track_id: m.new_track_id });
    void window.snipette.timeline.updateClip(m.id, { track_id: m.new_track_id }).catch(() => {});
  }
}

/** Rename selected clip (text/sticker contents) or selected track. */
function renameSelection(): void {
  const tStore = useTimelineStore.getState();
  const pushToast = useEditorStore.getState().pushToast;
  if (tStore.selectedTrackId) {
    const track = tStore.tracks.find((t) => t.id === tStore.selectedTrackId);
    if (!track) return;
    const next = window.prompt('Rename track', track.name);
    if (next == null || next === track.name) return;
    const updated = { ...track, name: next };
    tStore.upsertTrack(updated);
    void window.snipette.timeline.updateTrack(track.id, { name: next }).catch(() => {});
    return;
  }
  if (tStore.selectedClipIds.length === 1) {
    const clip = tStore.clips.find((c) => c.id === tStore.selectedClipIds[0]);
    if (!clip) return;
    // Text clips: rename = edit text_content. Other clip kinds have no display name
    // attached at the clip layer, so we surface that explicitly instead of silently no-op.
    if (clip.text_content !== null) {
      const next = window.prompt('Edit text', clip.text_content);
      if (next == null || next === clip.text_content) return;
      tStore.pushHistory();
      tStore.updateClipLocal(clip.id, { text_content: next });
      void window.snipette.timeline.updateClip(clip.id, { text_content: next }).catch(() => {});
      return;
    }
    pushToast({ kind: 'info', message: 'Only text clips and tracks can be renamed. Try selecting a track.' });
    return;
  }
  pushToast({ kind: 'info', message: 'Select a single clip or track to rename.' });
}

/** Set in/out point on selected clip by clamping source_in_ms / source_out_ms
 *  to the playhead's position relative to the clip's timeline start. */
function setInOutOnSelected(side: 'in' | 'out'): void {
  const tStore = useTimelineStore.getState();
  const pushToast = useEditorStore.getState().pushToast;
  if (tStore.selectedClipIds.length !== 1) {
    pushToast({ kind: 'info', message: 'Select one clip to set in/out.' });
    return;
  }
  const clip = tStore.clips.find((c) => c.id === tStore.selectedClipIds[0]);
  if (!clip) return;
  const offset = tStore.playheadMs - clip.start_time_ms;
  if (offset < 0 || offset > clip.duration_ms) {
    pushToast({ kind: 'info', message: 'Playhead is outside the selected clip.' });
    return;
  }
  // Convert clip-timeline offset to source-time offset.
  const sourceAtPlayhead = clip.source_in_ms + offset;
  if (side === 'in') {
    if (sourceAtPlayhead >= clip.source_out_ms) return;
    tStore.pushHistory();
    const trim = sourceAtPlayhead - clip.source_in_ms;
    const updates = {
      source_in_ms: sourceAtPlayhead,
      start_time_ms: clip.start_time_ms + trim,
      duration_ms: clip.duration_ms - trim,
    };
    tStore.updateClipLocal(clip.id, updates);
    void window.snipette.timeline.updateClip(clip.id, updates).catch(() => {});
  } else {
    if (sourceAtPlayhead <= clip.source_in_ms) return;
    tStore.pushHistory();
    const newDuration = sourceAtPlayhead - clip.source_in_ms;
    const updates = {
      source_out_ms: sourceAtPlayhead,
      duration_ms: newDuration,
    };
    tStore.updateClipLocal(clip.id, updates);
    void window.snipette.timeline.updateClip(clip.id, updates).catch(() => {});
  }
  tStore.computeDuration();
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Skip when typing in an input/textarea/contenteditable.
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }

      const tStore = useTimelineStore.getState();
      const eStore = useEditorStore.getState();
      const pStore = useProjectStore.getState();
      const fps = pStore.activeProject?.fps ?? 30;

      // Alt + Backspace/Delete = ripple delete (close gap on the affected tracks).
      // Must be tested BEFORE the plain Delete path so the alt-modifier isn't lost.
      if (e.altKey && !isMod(e) && !e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault();
        if (tStore.selectedClipIds.length === 0) return;
        void tStore.rippleDeleteClips(tStore.selectedClipIds);
        return;
      }

      // Alt + Up/Down = move selected clips to adjacent same-kind track.
      if (e.altKey && !isMod(e) && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        moveSelectedClipsToAdjacentTrack(e.key === 'ArrowUp' ? 'up' : 'down');
        return;
      }

      // Plain keys
      if (!isMod(e) && !e.shiftKey && !e.altKey) {
        switch (e.key) {
          case ' ':
            e.preventDefault();
            tStore.togglePlay();
            return;
          case 'b':
            e.preventDefault();
            tStore.setActiveTool('razor');
            return;
          case 'v':
            e.preventDefault();
            tStore.setActiveTool('select');
            return;
          case 't':
            e.preventDefault();
            tStore.setActiveTool('text');
            return;
          case 's':
            // bare `s` collides with save when shifted; treat as sticker tool only.
            e.preventDefault();
            tStore.setActiveTool('sticker');
            return;
          case 'h':
            e.preventDefault();
            tStore.setActiveTool('hand');
            return;
          case 'z':
            e.preventDefault();
            tStore.setActiveTool('zoom');
            return;
          case 'm':
            e.preventDefault();
            tStore.addMarker(makeMarker(tStore.playheadMs));
            return;
          case '[':
            e.preventDefault();
            tStore.prevMarker();
            return;
          case ']':
            e.preventDefault();
            tStore.nextMarker();
            return;
          case 'g':
            e.preventDefault();
            eStore.toggleSafeZones();
            return;
          case 'f':
            e.preventDefault();
            eStore.toggleFullscreenPreview();
            return;
          case '?':
            e.preventDefault();
            eStore.openShortcuts();
            return;
          // JKL transport: J = reverse, K = pause, L = play forward.
          // Reverse playback isn't supported by the player yet — register the key as
          // a stub that nudges the playhead back 5 frames and toasts "Coming soon".
          case 'j':
            e.preventDefault();
            tStore.stepFrames(-5, fps);
            eStore.pushToast({ kind: 'info', message: 'Reverse playback coming soon — stepped back 5 frames.' });
            return;
          case 'k':
            e.preventDefault();
            tStore.pause();
            return;
          case 'l':
            e.preventDefault();
            tStore.play();
            return;
          // Frame-precise clip nudge (J-cut / L-cut style trims).
          case ',':
            e.preventDefault();
            nudgeSelectedClipsFrames(-1, fps);
            return;
          case '.':
            e.preventDefault();
            nudgeSelectedClipsFrames(1, fps);
            return;
          case 'n':
            e.preventDefault();
            tStore.toggleSnap();
            return;
          case 'i':
            e.preventDefault();
            setInOutOnSelected('in');
            return;
          case 'o':
            e.preventDefault();
            setInOutOnSelected('out');
            return;
          case 'Escape':
            tStore.clearSelection();
            eStore.setContextMenu(null);
            return;
          case 'ArrowRight':
            e.preventDefault();
            tStore.stepFrames(1, fps);
            return;
          case 'ArrowLeft':
            e.preventDefault();
            tStore.stepFrames(-1, fps);
            return;
          case 'Home':
            e.preventDefault();
            tStore.seekToStart();
            return;
          case 'End':
            e.preventDefault();
            tStore.seekToEnd();
            return;
          case 'Delete':
          case 'Backspace':
            // Markers take priority over transitions/clips.
            if (tStore.selectedMarkerIds.length > 0) {
              e.preventDefault();
              tStore.removeSelectedMarkers();
              return;
            }
            // Delete a selected transition first (if any), otherwise fall through to clips.
            if (tStore.selectedTransitionId) {
              const tid = tStore.selectedTransitionId;
              tStore.pushHistory();
              void window.snipette.timeline.deleteTransition(tid);
              tStore.removeTransitionLocal(tid);
              tStore.selectTransition(null);
              return;
            }
            if (tStore.selectedClipIds.length === 0) return;
            tStore.pushHistory();
            for (const id of tStore.selectedClipIds) {
              void window.snipette.timeline.deleteClip(id);
              tStore.removeClip(id);
            }
            tStore.computeDuration();
            return;
        }
      }

      // Shift + arrows = 10 frame playhead jump.
      // Shift + , / . = 10 frame clip nudge.
      if (e.shiftKey && !isMod(e) && !e.altKey) {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          tStore.stepFrames(10, fps);
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          tStore.stepFrames(-10, fps);
          return;
        }
        // Shift+, produces "<" on US layouts. Match both key forms so it works regardless.
        if (e.key === '<' || e.key === ',') {
          e.preventDefault();
          nudgeSelectedClipsFrames(-10, fps);
          return;
        }
        if (e.key === '>' || e.key === '.') {
          e.preventDefault();
          nudgeSelectedClipsFrames(10, fps);
          return;
        }
      }

      if (isMod(e)) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault();
          tStore.undo();
          return;
        }
        if (k === 'z' && e.shiftKey) {
          e.preventDefault();
          tStore.redo();
          return;
        }
        if (k === 'a') {
          e.preventDefault();
          tStore.selectAll();
          return;
        }
        if (k === 'b') {
          // Split selected at playhead. Distinct from the bare `b` razor-tool toggle:
          // ⌘B performs the split immediately without changing the active tool.
          e.preventDefault();
          splitSelectedAtPlayhead();
          return;
        }
        if (k === 'r') {
          e.preventDefault();
          renameSelection();
          return;
        }
        if (k === 'd' && e.shiftKey) {
          // Detach audio from a selected video clip. Backend support for spinning up a
          // sibling audio track + cloned clip doesn't exist yet — register as a stub
          // so the binding is discoverable but doesn't silently fail.
          e.preventDefault();
          eStore.pushToast({ kind: 'info', message: 'Detach audio coming soon.' });
          return;
        }
        if (k === 'd') {
          e.preventDefault();
          if (tStore.selectedClipIds.length === 0) return;
          tStore.pushHistory();
          // duplicate
          for (const id of tStore.selectedClipIds) {
            const clip = tStore.clips.find((c) => c.id === id);
            if (!clip) continue;
            void window.snipette.timeline
              .addClip(clip.track_id, {
                track_id: clip.track_id,
                project_id: clip.project_id,
                asset_id: clip.asset_id ?? undefined,
                start_time_ms: clip.start_time_ms + clip.duration_ms,
                duration_ms: clip.duration_ms,
                source_in_ms: clip.source_in_ms,
                source_out_ms: clip.source_out_ms,
                text_content: clip.text_content ?? undefined,
              })
              .then((nc) => tStore.addClip(nc));
          }
          return;
        }
        if (k === 'e') {
          e.preventDefault();
          eStore.openExport();
          return;
        }
        if (k === '=' || k === '+') {
          e.preventDefault();
          tStore.zoomIn();
          return;
        }
        if (k === '-') {
          e.preventDefault();
          tStore.zoomOut();
          return;
        }
        if (k === '0') {
          e.preventDefault();
          tStore.fitTimeline(900);
          return;
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
