import { ipcMain, BrowserWindow } from 'electron';
import { v4 as uuid } from 'uuid';
import { CH } from '../../shared/types';
import type { CreateProjectOpts, Project, Track } from '../../shared/types';
import { getDb } from '../services/db.service';

const DEFAULT_TRACKS: Omit<Track, 'id' | 'project_id'>[] = [
  { type: 'video', name: 'V1 · Main', order_index: 0, color: '#C8F23A', is_visible: 1, is_locked: 0, is_muted: 0, height: 42 },
  { type: 'video', name: 'V2 · Overlay', order_index: 1, color: '#3AC8F2', is_visible: 1, is_locked: 0, is_muted: 0, height: 42 },
  { type: 'audio', name: 'A1 · Voiceover', order_index: 2, color: '#F2A83A', is_visible: 1, is_locked: 0, is_muted: 0, height: 42 },
  { type: 'audio', name: 'A2 · Music', order_index: 3, color: '#F2A83A', is_visible: 1, is_locked: 0, is_muted: 0, height: 42 },
  { type: 'text', name: 'TX · Captions', order_index: 4, color: '#F23AC8', is_visible: 1, is_locked: 0, is_muted: 0, height: 42 },
  { type: 'sticker', name: 'FX · Stickers', order_index: 5, color: '#9C3AF2', is_visible: 1, is_locked: 0, is_muted: 0, height: 42 },
];

export function registerProjectHandlers(_getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CH.projectList, (): Project[] => {
    const db = getDb();
    return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Project[];
  });

  ipcMain.handle(CH.projectCreate, (_e, opts: CreateProjectOpts): Project => {
    const db = getDb();
    const now = Date.now();
    const id = uuid();
    const project: Project = {
      id,
      name: opts.name || 'Untitled project',
      format: opts.format,
      width: opts.width,
      height: opts.height,
      fps: opts.fps,
      duration_ms: 0,
      created_at: now,
      updated_at: now,
      thumbnail_path: null,
      settings_json: null,
    };
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO projects (id, name, format, width, height, fps, duration_ms, created_at, updated_at, thumbnail_path, settings_json)
         VALUES (@id, @name, @format, @width, @height, @fps, @duration_ms, @created_at, @updated_at, @thumbnail_path, @settings_json)`,
      ).run(project);
      const insertTrack = db.prepare(
        `INSERT INTO tracks (id, project_id, type, name, order_index, color, is_visible, is_locked, is_muted, height)
         VALUES (@id, @project_id, @type, @name, @order_index, @color, @is_visible, @is_locked, @is_muted, @height)`,
      );
      for (const t of DEFAULT_TRACKS) {
        insertTrack.run({ ...t, id: uuid(), project_id: id });
      }
    });
    tx();
    return project;
  });

  ipcMain.handle(CH.projectOpen, (_e, id: string): Project => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
    if (!row) throw new Error(`Project ${id} not found`);
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    return row;
  });

  ipcMain.handle(CH.projectSave, (_e, project: Project): void => {
    const db = getDb();
    db.prepare(
      `UPDATE projects SET name = @name, format = @format, width = @width, height = @height,
       fps = @fps, duration_ms = @duration_ms, updated_at = @updated_at, thumbnail_path = @thumbnail_path,
       settings_json = @settings_json WHERE id = @id`,
    ).run({ ...project, updated_at: Date.now() });
  });

  ipcMain.handle(CH.projectDelete, (_e, id: string): void => {
    const db = getDb();
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  });

  ipcMain.handle(CH.projectDuplicate, (_e, id: string): Project => {
    const db = getDb();
    const orig = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
    if (!orig) throw new Error(`Project ${id} not found`);
    const newId = uuid();
    const now = Date.now();
    const dup: Project = { ...orig, id: newId, name: `${orig.name} copy`, created_at: now, updated_at: now };
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO projects (id, name, format, width, height, fps, duration_ms, created_at, updated_at, thumbnail_path, settings_json)
         VALUES (@id, @name, @format, @width, @height, @fps, @duration_ms, @created_at, @updated_at, @thumbnail_path, @settings_json)`,
      ).run(dup);
      // Copy tracks
      const tracks = db.prepare('SELECT * FROM tracks WHERE project_id = ?').all(id) as Track[];
      const trackIdMap = new Map<string, string>();
      const insertTrack = db.prepare(
        `INSERT INTO tracks (id, project_id, type, name, order_index, color, is_visible, is_locked, is_muted, height)
         VALUES (@id, @project_id, @type, @name, @order_index, @color, @is_visible, @is_locked, @is_muted, @height)`,
      );
      for (const t of tracks) {
        const nid = uuid();
        trackIdMap.set(t.id, nid);
        insertTrack.run({ ...t, id: nid, project_id: newId });
      }
      // Copy clips
      const clips = db.prepare('SELECT * FROM clips WHERE project_id = ?').all(id) as Record<string, unknown>[];
      const insertClip = db.prepare(
        `INSERT INTO clips (id, track_id, project_id, asset_id, start_time_ms, duration_ms, source_in_ms, source_out_ms,
         position_x, position_y, scale_x, scale_y, rotation, opacity, volume, speed, is_reversed,
         color_grade_json, effects_json, text_content, text_style_json, text_animation_json, sticker_id, created_at)
         VALUES (@id, @track_id, @project_id, @asset_id, @start_time_ms, @duration_ms, @source_in_ms, @source_out_ms,
         @position_x, @position_y, @scale_x, @scale_y, @rotation, @opacity, @volume, @speed, @is_reversed,
         @color_grade_json, @effects_json, @text_content, @text_style_json, @text_animation_json, @sticker_id, @created_at)`,
      );
      for (const c of clips) {
        const nid = uuid();
        const newTrackId = trackIdMap.get(c.track_id as string) ?? null;
        if (!newTrackId) continue;
        insertClip.run({ ...c, id: nid, track_id: newTrackId, project_id: newId });
      }
    });
    tx();
    return dup;
  });

  ipcMain.handle(CH.projectRename, (_e, id: string, name: string): void => {
    const db = getDb();
    db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
  });
}
