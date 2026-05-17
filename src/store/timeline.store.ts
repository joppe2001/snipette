import { create } from 'zustand';
import type { Clip, Track, Transition } from '@shared/types';
import type { Marker } from '@/utils/markers';
import { computeRippleDelete, computeSlip } from '@/utils/timeline-edits';

interface HistoryEntry {
  tracks: Track[];
  clips: Clip[];
  transitions: Transition[];
}

interface TimelineState {
  projectId: string | null;
  tracks: Track[];
  clips: Clip[];
  transitions: Transition[];
  playheadMs: number;
  durationMs: number;
  zoomLevel: number; // px per second
  scrollOffsetMs: number;
  selectedClipIds: string[];
  selectedTrackId: string | null;
  selectedTransitionId: string | null;
  markers: Marker[];
  /** Markers the user has explicitly clicked. Shift/cmd-click toggles selection so
   *  multiple markers can be picked and bulk-deleted. The classic single-select case
   *  is just `[id]`. */
  selectedMarkerIds: string[];
  isPlaying: boolean;
  snapEnabled: boolean;
  snapThresholdPx: number;
  activeTool: 'select' | 'razor' | 'text' | 'sticker' | 'hand' | 'zoom';
  history: HistoryEntry[];
  historyIndex: number;

  load: (
    projectId: string,
    payload: { tracks: Track[]; clips: Clip[]; transitions: Transition[] },
    durationMs: number,
  ) => void;
  reset: () => void;

  setPlayhead: (ms: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seekToStart: () => void;
  seekToEnd: () => void;
  stepFrames: (n: number, fps: number) => void;

  setZoom: (level: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitTimeline: (viewportWidthPx: number) => void;
  setScroll: (offsetMs: number) => void;

  setActiveTool: (tool: TimelineState['activeTool']) => void;
  toggleSnap: () => void;

  selectClip: (id: string, multi?: boolean) => void;
  selectTrack: (id: string | null) => void;
  selectTransition: (id: string | null) => void;
  clearSelection: () => void;
  selectAll: () => void;

  addMarker: (m: Marker) => void;
  updateMarker: (id: string, updates: Partial<Marker>) => void;
  removeMarker: (id: string) => void;
  /** Remove every marker whose id is in `selectedMarkerIds`. No-op if none selected. */
  removeSelectedMarkers: () => void;
  /** Single-select (no modifier) or shift/cmd-click toggle if `multi: true`. Passing
   *  `null` clears the selection. */
  selectMarker: (id: string | null, multi?: boolean) => void;
  nextMarker: () => void;
  prevMarker: () => void;
  clearMarkers: () => void;

  addClip: (clip: Clip) => void;
  updateClipLocal: (id: string, updates: Partial<Clip>) => void;
  removeClip: (id: string) => void;
  replaceClip: (clip: Clip) => void;
  rippleDeleteClips: (ids: string[]) => Promise<void>;
  slipClip: (id: string, deltaMs: number, sourceDurationMs: number) => Promise<void>;
  setTracks: (tracks: Track[]) => void;
  upsertTrack: (track: Track) => void;
  removeTrack: (id: string) => void;
  reorderTracksLocal: (orderedIds: string[]) => void;
  addTransitionLocal: (t: Transition) => void;
  updateTransitionLocal: (id: string, updates: Partial<Transition>) => void;
  removeTransitionLocal: (id: string) => void;

  pushHistory: () => void;
  undo: () => void;
  redo: () => void;

  computeDuration: () => number;
}

// Lowered from 80 to 40: heavily-keyframed projects can have multi-MB snapshots, so 80
// entries could pin ~100MB of history in RAM. 40 is still a generous undo depth.
const HISTORY_LIMIT = 40;

/**
 * Diff the current store against a target snapshot and emit IPC writes that move SQLite
 * to match. Fire-and-forget — the in-memory state has already been updated by the caller.
 * Used by undo/redo.
 */
function reconcileToTarget(
  current: { tracks: Track[]; clips: Clip[]; transitions: Transition[] },
  target: HistoryEntry,
): void {
  const curClipIds = new Set(current.clips.map((c) => c.id));
  const tgtClipIds = new Set(target.clips.map((c) => c.id));

  // Clips removed in target → delete them now.
  for (const id of curClipIds) {
    if (!tgtClipIds.has(id)) {
      void window.snipette.timeline.deleteClip(id).catch(() => {});
    }
  }
  // Clips present in target. Either restore (added) or update (existed).
  for (const tc of target.clips) {
    if (!curClipIds.has(tc.id)) {
      // Was deleted — re-add. addClip generates a NEW id server-side, so we can't perfectly
      // round-trip. Best effort: use updateClip with the original id if possible; if that 404s,
      // create a fresh one.
      void window.snipette.timeline
        .updateClip(tc.id, tc)
        .catch(() =>
          window.snipette.timeline.addClip(tc.track_id, {
            track_id: tc.track_id,
            project_id: tc.project_id,
            asset_id: tc.asset_id ?? undefined,
            start_time_ms: tc.start_time_ms,
            duration_ms: tc.duration_ms,
            source_in_ms: tc.source_in_ms,
            source_out_ms: tc.source_out_ms,
            text_content: tc.text_content ?? undefined,
            text_style_json: tc.text_style_json ?? undefined,
          }),
        );
    } else {
      const cur = current.clips.find((c) => c.id === tc.id);
      if (cur && JSON.stringify(cur) !== JSON.stringify(tc)) {
        void window.snipette.timeline.updateClip(tc.id, tc).catch(() => {});
      }
    }
  }
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  projectId: null,
  tracks: [],
  clips: [],
  transitions: [],
  playheadMs: 0,
  durationMs: 0,
  zoomLevel: 80,
  scrollOffsetMs: 0,
  selectedClipIds: [],
  selectedTrackId: null,
  selectedTransitionId: null,
  markers: [],
  selectedMarkerIds: [],
  isPlaying: false,
  snapEnabled: true,
  snapThresholdPx: 8,
  activeTool: 'select',
  history: [],
  historyIndex: -1,

  load: (projectId, payload, durationMs) => {
    set({
      projectId,
      tracks: payload.tracks,
      clips: payload.clips,
      transitions: payload.transitions,
      durationMs,
      playheadMs: 0,
      selectedClipIds: [],
      selectedTrackId: null,
      markers: [],
      selectedMarkerIds: [],
      isPlaying: false,
      history: [{ tracks: payload.tracks, clips: payload.clips, transitions: payload.transitions }],
      historyIndex: 0,
    });
  },

  reset: () =>
    set({
      projectId: null,
      tracks: [],
      clips: [],
      transitions: [],
      durationMs: 0,
      playheadMs: 0,
      selectedClipIds: [],
      selectedTrackId: null,
      markers: [],
      selectedMarkerIds: [],
      isPlaying: false,
      history: [],
      historyIndex: -1,
    }),

  setPlayhead: (ms) => {
    const d = get().durationMs;
    set({ playheadMs: Math.max(0, Math.min(d || ms, ms)) });
  },

  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),

  seekToStart: () => set({ playheadMs: 0 }),
  seekToEnd: () => set((s) => ({ playheadMs: s.durationMs })),

  stepFrames: (n, fps) =>
    set((s) => {
      const dt = (1000 / fps) * n;
      return { playheadMs: Math.max(0, Math.min(s.durationMs, s.playheadMs + dt)) };
    }),

  setZoom: (level) => set({ zoomLevel: Math.max(20, Math.min(400, level)) }),
  zoomIn: () => set((s) => ({ zoomLevel: Math.min(400, s.zoomLevel * 1.2) })),
  zoomOut: () => set((s) => ({ zoomLevel: Math.max(20, s.zoomLevel / 1.2) })),
  fitTimeline: (viewport) =>
    set((s) => {
      const dur = Math.max(1, s.durationMs / 1000);
      return { zoomLevel: Math.max(20, Math.min(400, viewport / dur)), scrollOffsetMs: 0 };
    }),
  setScroll: (offset) => set({ scrollOffsetMs: Math.max(0, offset) }),

  setActiveTool: (tool) => set({ activeTool: tool }),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),

  selectClip: (id, multi = false) =>
    set((s) => {
      if (multi) {
        return {
          selectedClipIds: s.selectedClipIds.includes(id)
            ? s.selectedClipIds.filter((c) => c !== id)
            : [...s.selectedClipIds, id],
          selectedTrackId: null,
          selectedTransitionId: null,
          selectedMarkerIds: [],
        };
      }
      // Seek the playhead into the clip's range if it's currently outside.
      // Lets the preview actually show what was just selected without forcing
      // the user to scrub. If playhead is already inside the clip, leave it.
      const clip = s.clips.find((c) => c.id === id);
      let playheadMs = s.playheadMs;
      if (clip) {
        const start = clip.start_time_ms;
        const end = start + clip.duration_ms;
        if (s.playheadMs < start || s.playheadMs >= end) {
          // For text clips, jump to the middle of the clip — guaranteed past
          // the intro animation and before any outro, so the user sees the
          // resting state. Non-text clips just need to clear the boundary.
          const nudge = clip.text_content
            ? Math.floor(clip.duration_ms / 2)
            : Math.min(80, Math.max(1, Math.floor(clip.duration_ms * 0.05)));
          playheadMs = start + nudge;
        }
      }
      return {
        selectedClipIds: [id],
        selectedTrackId: null,
        selectedTransitionId: null,
        selectedMarkerIds: [],
        playheadMs,
      };
    }),

  selectTrack: (id) =>
    set({ selectedTrackId: id, selectedClipIds: [], selectedTransitionId: null, selectedMarkerIds: [] }),
  selectTransition: (id) =>
    set({ selectedTransitionId: id, selectedClipIds: [], selectedTrackId: null, selectedMarkerIds: [] }),
  clearSelection: () =>
    set({ selectedClipIds: [], selectedTrackId: null, selectedTransitionId: null, selectedMarkerIds: [] }),
  selectAll: () => set((s) => ({ selectedClipIds: s.clips.map((c) => c.id) })),

  addMarker: (m) =>
    set((s) => ({
      markers: [...s.markers, m].sort((a, b) => a.time_ms - b.time_ms),
    })),

  updateMarker: (id, updates) =>
    set((s) => {
      const next = s.markers.map((m) => (m.id === id ? { ...m, ...updates } : m));
      if (updates.time_ms !== undefined) {
        next.sort((a, b) => a.time_ms - b.time_ms);
      }
      return { markers: next };
    }),

  removeMarker: (id) =>
    set((s) => ({
      markers: s.markers.filter((m) => m.id !== id),
      selectedMarkerIds: s.selectedMarkerIds.filter((mid) => mid !== id),
    })),

  removeSelectedMarkers: () =>
    set((s) => {
      if (s.selectedMarkerIds.length === 0) return s;
      const dead = new Set(s.selectedMarkerIds);
      return {
        markers: s.markers.filter((m) => !dead.has(m.id)),
        selectedMarkerIds: [],
      };
    }),

  selectMarker: (id, multi = false) =>
    set((s) => {
      if (id == null) return { selectedMarkerIds: [] };
      if (!multi) return { selectedMarkerIds: [id] };
      // Shift/cmd-click toggles membership in the selection set.
      return s.selectedMarkerIds.includes(id)
        ? { selectedMarkerIds: s.selectedMarkerIds.filter((mid) => mid !== id) }
        : { selectedMarkerIds: [...s.selectedMarkerIds, id] };
    }),

  nextMarker: () => {
    const s = get();
    const target = s.markers.find((m) => m.time_ms > s.playheadMs);
    if (target) s.setPlayhead(target.time_ms);
  },

  prevMarker: () => {
    const s = get();
    let target: Marker | undefined;
    for (const m of s.markers) {
      if (m.time_ms < s.playheadMs) target = m;
      else break;
    }
    if (target) s.setPlayhead(target.time_ms);
  },

  clearMarkers: () => set({ markers: [], selectedMarkerIds: [] }),

  addClip: (clip) =>
    set((s) => ({
      clips: [...s.clips, clip].sort((a, b) => a.start_time_ms - b.start_time_ms),
    })),

  updateClipLocal: (id, updates) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    })),

  replaceClip: (clip) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === clip.id ? clip : c)),
    })),

  removeClip: (id) =>
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== id),
      selectedClipIds: s.selectedClipIds.filter((cid) => cid !== id),
    })),

  rippleDeleteClips: async (ids) => {
    if (ids.length === 0) return;
    const state = get();
    const result = computeRippleDelete(state.clips, ids);
    if (result.toDelete.length === 0) return;
    state.pushHistory();
    const deleteSet = new Set(result.toDelete);
    const shiftMap = new Map(result.toShift.map((s) => [s.id, s.new_start_ms]));
    set((s) => ({
      clips: s.clips
        .filter((c) => !deleteSet.has(c.id))
        .map((c) => {
          const next = shiftMap.get(c.id);
          return next === undefined ? c : { ...c, start_time_ms: next };
        }),
      selectedClipIds: s.selectedClipIds.filter((cid) => !deleteSet.has(cid)),
    }));
    // Persist: deletes + shifts. Fire-and-forget — UI already reflects the new state.
    for (const id of result.toDelete) {
      void window.snipette.timeline.deleteClip(id).catch(() => {});
    }
    for (const { id, new_start_ms } of result.toShift) {
      void window.snipette.timeline.updateClip(id, { start_time_ms: new_start_ms }).catch(() => {});
    }
    get().computeDuration();
  },

  slipClip: async (id, deltaMs, sourceDurationMs) => {
    const clip = get().clips.find((c) => c.id === id);
    if (!clip) return;
    const result = computeSlip(clip, deltaMs, sourceDurationMs);
    if (
      result.source_in_ms === clip.source_in_ms &&
      result.source_out_ms === clip.source_out_ms
    ) {
      return;
    }
    get().pushHistory();
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, ...result } : c)),
    }));
    try {
      await window.snipette.timeline.updateClip(id, result);
    } catch {
      // Local state already updated optimistically; remote failure is non-fatal for now.
    }
  },

  setTracks: (tracks) => set({ tracks }),
  upsertTrack: (track) =>
    set((s) => {
      const exists = s.tracks.some((t) => t.id === track.id);
      return {
        tracks: exists
          ? s.tracks.map((t) => (t.id === track.id ? track : t))
          : [...s.tracks, track].sort((a, b) => a.order_index - b.order_index),
      };
    }),
  removeTrack: (id) =>
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== id),
      clips: s.clips.filter((c) => c.track_id !== id),
    })),
  reorderTracksLocal: (orderedIds) =>
    set((s) => {
      const byId = new Map(s.tracks.map((t) => [t.id, t]));
      const next: Track[] = [];
      for (let i = 0; i < orderedIds.length; i++) {
        const t = byId.get(orderedIds[i]);
        if (t) next.push({ ...t, order_index: i });
      }
      // Tracks not in orderedIds (shouldn't happen, but defensively) get appended at the end.
      for (const t of s.tracks) if (!orderedIds.includes(t.id)) next.push(t);
      return { tracks: next };
    }),
  addTransitionLocal: (t) => set((s) => ({ transitions: [...s.transitions, t] })),
  updateTransitionLocal: (id, updates) =>
    set((s) => ({
      transitions: s.transitions.map((t) => (t.id === id ? { ...t, ...updates, id: t.id } : t)),
    })),
  removeTransitionLocal: (id) =>
    set((s) => ({ transitions: s.transitions.filter((t) => t.id !== id) })),

  pushHistory: () =>
    set((s) => {
      const entry: HistoryEntry = { tracks: s.tracks, clips: s.clips, transitions: s.transitions };
      const trimmed = s.history.slice(0, s.historyIndex + 1);
      const next = [...trimmed, entry].slice(-HISTORY_LIMIT);
      return { history: next, historyIndex: next.length - 1 };
    }),

  undo: () => {
    const s = get();
    if (s.historyIndex <= 0) return;
    const targetIdx = s.historyIndex - 1;
    const target = s.history[targetIdx];
    reconcileToTarget(s, target);
    set({
      ...target,
      historyIndex: targetIdx,
      selectedClipIds: [],
      selectedTrackId: null,
    });
  },

  redo: () => {
    const s = get();
    if (s.historyIndex >= s.history.length - 1) return;
    const targetIdx = s.historyIndex + 1;
    const target = s.history[targetIdx];
    reconcileToTarget(s, target);
    set({
      ...target,
      historyIndex: targetIdx,
      selectedClipIds: [],
      selectedTrackId: null,
    });
  },

  computeDuration: () => {
    const { clips } = get();
    const d = clips.reduce((m, c) => Math.max(m, c.start_time_ms + c.duration_ms), 0);
    set({ durationMs: d });
    return d;
  },
}));

/** Convenience for components: snapshot, then run a mutation. */
export function withHistory(label: string, mutate: () => void | Promise<void>): void {
  void label;
  useTimelineStore.getState().pushHistory();
  void Promise.resolve(mutate()).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn('[timeline] mutation failed', label, e);
  });
}

