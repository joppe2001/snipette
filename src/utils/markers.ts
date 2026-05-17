/**
 * Markers / chapters that float above the timeline ruler. Renderer-only for v1 —
 * not persisted to SQLite yet. See TODO at bottom of file for the persistence plan.
 */

export interface Marker {
  id: string;
  time_ms: number;
  label: string;
  color: string;
}

export const MARKER_COLORS: readonly string[] = [
  '#C8F23A', // lime (default)
  '#F23AC8', // magenta
  '#3AC8F2', // cyan
  '#F2A83A', // orange
  '#F23A5E', // red
  '#9C3AF2', // purple
] as const;

export function makeMarker(time_ms: number, label = '', color: string = MARKER_COLORS[0]): Marker {
  return {
    id: crypto.randomUUID(),
    time_ms,
    label,
    color,
  };
}

// TODO(persistence): once markers are wired to SQLite, this util will gain a
// `dbToMarker(row)` and `markerToCreate(m)` helper pair. Schema sketch:
//   CREATE TABLE markers (
//     id TEXT PRIMARY KEY,
//     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
//     time_ms INTEGER NOT NULL,
//     label TEXT NOT NULL DEFAULT '',
//     color TEXT NOT NULL,
//     created_at INTEGER NOT NULL
//   );
// IPC channels (under existing timeline:* namespace):
//   timeline:list-markers, timeline:add-marker, timeline:update-marker, timeline:delete-marker
