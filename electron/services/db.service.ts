import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import log from 'electron-log';

let db: Database.Database | null = null;

const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        format TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        fps INTEGER NOT NULL DEFAULT 30,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        thumbnail_path TEXT,
        settings_json TEXT
      );

      CREATE TABLE media_assets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        original_path TEXT NOT NULL,
        proxy_path TEXT,
        thumbnail_path TEXT,
        waveform_path TEXT,
        type TEXT NOT NULL,
        duration_ms INTEGER,
        width INTEGER,
        height INTEGER,
        fps REAL,
        file_size INTEGER,
        codec TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_media_project ON media_assets(project_id);

      CREATE TABLE tracks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        color TEXT NOT NULL,
        is_visible INTEGER NOT NULL DEFAULT 1,
        is_locked INTEGER NOT NULL DEFAULT 0,
        is_muted INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 42
      );
      CREATE INDEX idx_tracks_project ON tracks(project_id);

      CREATE TABLE clips (
        id TEXT PRIMARY KEY,
        track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        asset_id TEXT REFERENCES media_assets(id),
        start_time_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        source_in_ms INTEGER NOT NULL DEFAULT 0,
        source_out_ms INTEGER NOT NULL,
        position_x REAL NOT NULL DEFAULT 0,
        position_y REAL NOT NULL DEFAULT 0,
        scale_x REAL NOT NULL DEFAULT 1,
        scale_y REAL NOT NULL DEFAULT 1,
        rotation REAL NOT NULL DEFAULT 0,
        opacity REAL NOT NULL DEFAULT 1,
        volume REAL NOT NULL DEFAULT 1,
        speed REAL NOT NULL DEFAULT 1,
        is_reversed INTEGER NOT NULL DEFAULT 0,
        color_grade_json TEXT,
        effects_json TEXT,
        text_content TEXT,
        text_style_json TEXT,
        text_animation_json TEXT,
        sticker_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_clips_track ON clips(track_id);
      CREATE INDEX idx_clips_project ON clips(project_id);

      CREATE TABLE transitions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        clip_a_id TEXT NOT NULL,
        clip_b_id TEXT NOT NULL,
        type TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 500,
        params_json TEXT
      );
      CREATE INDEX idx_transitions_project ON transitions(project_id);

      CREATE TABLE history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

export function initDatabase(): Database.Database {
  if (db) return db;
  const userData = app.getPath('userData');
  const dbDir = path.join(userData, 'projects');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'snipette.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  runMigrations(db);
  log.info(`[db] opened ${dbPath}`);
  return db;
}

function runMigrations(database: Database.Database): void {
  // Bootstrap: ensure schema_version exists, in case the DB existed pre-migration.
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0
    );
  `);
  const row = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as
    | { version: number }
    | undefined;
  let current = row?.version ?? 0;
  if (!row) database.exec('INSERT INTO schema_version (id, version) VALUES (1, 0)');

  for (const m of MIGRATIONS) {
    if (m.id > current) {
      database.exec('BEGIN');
      try {
        database.exec(m.sql);
        database.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(m.id);
        database.exec('COMMIT');
        current = m.id;
        log.info(`[db] migration ${m.id} applied`);
      } catch (e) {
        database.exec('ROLLBACK');
        log.error(`[db] migration ${m.id} failed`, e);
        throw e;
      }
    }
  }
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    log.info('[db] closed');
  }
}
