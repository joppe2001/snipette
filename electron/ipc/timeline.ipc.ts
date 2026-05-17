import { ipcMain } from 'electron';
import { v4 as uuid } from 'uuid';
import { CH } from '../../shared/types';
import type { Clip, ClipCreate, Track, TrackCreate, Transition, TransitionCreate } from '../../shared/types';
import { getDb } from '../services/db.service';

function blankClip(create: ClipCreate): Clip {
  return {
    id: uuid(),
    track_id: create.track_id,
    project_id: create.project_id,
    asset_id: create.asset_id ?? null,
    start_time_ms: create.start_time_ms,
    duration_ms: create.duration_ms,
    source_in_ms: create.source_in_ms ?? 0,
    source_out_ms: create.source_out_ms ?? create.duration_ms,
    position_x: 0,
    position_y: 0,
    scale_x: 1,
    scale_y: 1,
    rotation: 0,
    opacity: 1,
    volume: 1,
    speed: 1,
    is_reversed: 0,
    color_grade_json: null,
    effects_json: null,
    text_content: create.text_content ?? null,
    text_style_json: create.text_style_json ?? null,
    text_animation_json: null,
    sticker_id: null,
    created_at: Date.now(),
  };
}

function updateProjectDuration(projectId: string): void {
  const db = getDb();
  const row = db
    .prepare('SELECT COALESCE(MAX(start_time_ms + duration_ms), 0) AS d FROM clips WHERE project_id = ?')
    .get(projectId) as { d: number } | undefined;
  db.prepare('UPDATE projects SET duration_ms = ?, updated_at = ? WHERE id = ?').run(
    row?.d ?? 0,
    Date.now(),
    projectId,
  );
}

export function registerTimelineHandlers(): void {
  ipcMain.handle(CH.timelineList, (_e, projectId: string) => {
    const db = getDb();
    return {
      tracks: db
        .prepare('SELECT * FROM tracks WHERE project_id = ? ORDER BY order_index')
        .all(projectId) as Track[],
      clips: db
        .prepare('SELECT * FROM clips WHERE project_id = ? ORDER BY start_time_ms')
        .all(projectId) as Clip[],
      transitions: db
        .prepare('SELECT * FROM transitions WHERE project_id = ?')
        .all(projectId) as Transition[],
    };
  });

  ipcMain.handle(CH.timelineAddClip, (_e, _trackId: string, create: ClipCreate): Clip => {
    const db = getDb();
    const clip = blankClip(create);
    db.prepare(
      `INSERT INTO clips (id, track_id, project_id, asset_id, start_time_ms, duration_ms, source_in_ms, source_out_ms,
       position_x, position_y, scale_x, scale_y, rotation, opacity, volume, speed, is_reversed,
       color_grade_json, effects_json, text_content, text_style_json, text_animation_json, sticker_id, created_at)
       VALUES (@id, @track_id, @project_id, @asset_id, @start_time_ms, @duration_ms, @source_in_ms, @source_out_ms,
       @position_x, @position_y, @scale_x, @scale_y, @rotation, @opacity, @volume, @speed, @is_reversed,
       @color_grade_json, @effects_json, @text_content, @text_style_json, @text_animation_json, @sticker_id, @created_at)`,
    ).run(clip);
    updateProjectDuration(clip.project_id);
    return clip;
  });

  ipcMain.handle(CH.timelineUpdateClip, (_e, clipId: string, updates: Partial<Clip>): Clip => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM clips WHERE id = ?').get(clipId) as Clip | undefined;
    if (!existing) throw new Error(`Clip ${clipId} not found`);
    const merged: Clip = { ...existing, ...updates, id: existing.id };
    db.prepare(
      `UPDATE clips SET track_id=@track_id, asset_id=@asset_id, start_time_ms=@start_time_ms,
       duration_ms=@duration_ms, source_in_ms=@source_in_ms, source_out_ms=@source_out_ms,
       position_x=@position_x, position_y=@position_y, scale_x=@scale_x, scale_y=@scale_y,
       rotation=@rotation, opacity=@opacity, volume=@volume, speed=@speed, is_reversed=@is_reversed,
       color_grade_json=@color_grade_json, effects_json=@effects_json,
       text_content=@text_content, text_style_json=@text_style_json, text_animation_json=@text_animation_json,
       sticker_id=@sticker_id WHERE id=@id`,
    ).run(merged);
    updateProjectDuration(merged.project_id);
    return merged;
  });

  ipcMain.handle(CH.timelineDeleteClip, (_e, clipId: string): void => {
    const db = getDb();
    const clip = db.prepare('SELECT project_id FROM clips WHERE id = ?').get(clipId) as
      | { project_id: string }
      | undefined;
    db.prepare('DELETE FROM clips WHERE id = ?').run(clipId);
    if (clip) updateProjectDuration(clip.project_id);
  });

  ipcMain.handle(CH.timelineSplitClip, (_e, clipId: string, atTimeMs: number): [Clip, Clip] => {
    const db = getDb();
    const orig = db.prepare('SELECT * FROM clips WHERE id = ?').get(clipId) as Clip | undefined;
    if (!orig) throw new Error(`Clip ${clipId} not found`);
    const splitOffset = atTimeMs - orig.start_time_ms;
    if (splitOffset <= 0 || splitOffset >= orig.duration_ms) {
      throw new Error('Split point is outside the clip range');
    }
    const leftDuration = splitOffset;
    const rightDuration = orig.duration_ms - splitOffset;
    const leftSourceOut = orig.source_in_ms + leftDuration * orig.speed;
    const rightId = uuid();
    const left: Clip = {
      ...orig,
      duration_ms: leftDuration,
      source_out_ms: leftSourceOut,
    };
    const right: Clip = {
      ...orig,
      id: rightId,
      start_time_ms: orig.start_time_ms + leftDuration,
      duration_ms: rightDuration,
      source_in_ms: leftSourceOut,
      source_out_ms: orig.source_out_ms,
      created_at: Date.now(),
    };
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE clips SET duration_ms=@duration_ms, source_out_ms=@source_out_ms WHERE id=@id`,
      ).run(left);
      db.prepare(
        `INSERT INTO clips (id, track_id, project_id, asset_id, start_time_ms, duration_ms, source_in_ms, source_out_ms,
         position_x, position_y, scale_x, scale_y, rotation, opacity, volume, speed, is_reversed,
         color_grade_json, effects_json, text_content, text_style_json, text_animation_json, sticker_id, created_at)
         VALUES (@id, @track_id, @project_id, @asset_id, @start_time_ms, @duration_ms, @source_in_ms, @source_out_ms,
         @position_x, @position_y, @scale_x, @scale_y, @rotation, @opacity, @volume, @speed, @is_reversed,
         @color_grade_json, @effects_json, @text_content, @text_style_json, @text_animation_json, @sticker_id, @created_at)`,
      ).run(right);
    });
    tx();
    return [left, right];
  });

  ipcMain.handle(CH.timelineAddTrack, (_e, opts: TrackCreate): Track => {
    const db = getDb();
    const max = db
      .prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM tracks WHERE project_id = ?')
      .get(opts.project_id) as { m: number };
    const colorByKind: Record<string, string> = {
      video: '#C8F23A',
      audio: '#F2A83A',
      text: '#F23AC8',
      sticker: '#9C3AF2',
      effect: '#9C3AF2',
    };
    const track: Track = {
      id: uuid(),
      project_id: opts.project_id,
      type: opts.type,
      name: opts.name ?? `${opts.type.toUpperCase()} · Track`,
      order_index: (max.m ?? -1) + 1,
      color: opts.color ?? colorByKind[opts.type] ?? '#C8F23A',
      is_visible: 1,
      is_locked: 0,
      is_muted: 0,
      height: 42,
    };
    db.prepare(
      `INSERT INTO tracks (id, project_id, type, name, order_index, color, is_visible, is_locked, is_muted, height)
       VALUES (@id, @project_id, @type, @name, @order_index, @color, @is_visible, @is_locked, @is_muted, @height)`,
    ).run(track);
    return track;
  });

  ipcMain.handle(CH.timelineDeleteTrack, (_e, trackId: string): void => {
    getDb().prepare('DELETE FROM tracks WHERE id = ?').run(trackId);
  });

  ipcMain.handle(CH.timelineReorderTrack, (_e, trackId: string, newIndex: number): void => {
    getDb().prepare('UPDATE tracks SET order_index = ? WHERE id = ?').run(newIndex, trackId);
  });

  ipcMain.handle(CH.timelineReorderTracks, (_e, orderedIds: string[]): void => {
    const db = getDb();
    // Run in a transaction so the intermediate states (which may have duplicate order_index
    // values mid-update) never become visible to readers.
    const update = db.prepare('UPDATE tracks SET order_index = ? WHERE id = ?');
    const tx = db.transaction((ids: string[]) => {
      // Two-pass write: first push everything to negative indices so we never collide with the
      // final values during the update, then write the real indices.
      for (let i = 0; i < ids.length; i++) update.run(-(i + 1), ids[i]);
      for (let i = 0; i < ids.length; i++) update.run(i, ids[i]);
    });
    tx(orderedIds);
  });

  ipcMain.handle(CH.timelineUpdateTrack, (_e, trackId: string, updates: Partial<Track>): Track => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) as Track | undefined;
    if (!existing) throw new Error(`Track ${trackId} not found`);
    const merged: Track = { ...existing, ...updates, id: existing.id };
    db.prepare(
      `UPDATE tracks SET name=@name, type=@type, order_index=@order_index, color=@color,
       is_visible=@is_visible, is_locked=@is_locked, is_muted=@is_muted, height=@height WHERE id=@id`,
    ).run(merged);
    return merged;
  });

  ipcMain.handle(CH.timelineDeleteTransition, (_e, id: string): void => {
    getDb().prepare('DELETE FROM transitions WHERE id = ?').run(id);
  });

  ipcMain.handle(
    CH.timelineUpdateTransition,
    (_e, id: string, updates: Partial<Transition>): Transition => {
      const db = getDb();
      const existing = db.prepare('SELECT * FROM transitions WHERE id = ?').get(id) as
        | Transition
        | undefined;
      if (!existing) throw new Error(`Transition ${id} not found`);
      const merged: Transition = { ...existing, ...updates, id: existing.id };
      db.prepare(
        `UPDATE transitions SET type=@type, duration_ms=@duration_ms, params_json=@params_json
         WHERE id=@id`,
      ).run(merged);
      return merged;
    },
  );

  ipcMain.handle(CH.timelineAddTransition, (_e, opts: TransitionCreate): Transition => {
    const t: Transition = {
      id: uuid(),
      project_id: opts.project_id,
      track_id: opts.track_id,
      clip_a_id: opts.clip_a_id,
      clip_b_id: opts.clip_b_id,
      type: opts.type,
      duration_ms: opts.duration_ms ?? 500,
      params_json: null,
    };
    getDb()
      .prepare(
        `INSERT INTO transitions (id, project_id, track_id, clip_a_id, clip_b_id, type, duration_ms, params_json)
         VALUES (@id, @project_id, @track_id, @clip_a_id, @clip_b_id, @type, @duration_ms, @params_json)`,
      )
      .run(t);
    return t;
  });
}
