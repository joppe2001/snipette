import { ipcMain } from 'electron';
import { CH } from '../../shared/types';
import { getDb } from '../services/db.service';

const DEFAULTS: Record<string, string> = {
  'theme': 'dark',
  'language': 'en',
  'autosave_interval_seconds': '15',
  'gpu_accel': '1',
  'preview_quality': 'auto',
  'cache_size_mb': '2048',
  'scratch_disk_path': '',
  'accent_color': '#C8F23A',
  'font_size_pct': '100',
  'timeline_density': 'normal',
  'show_safe_zones': '1',
  'check_updates': '0',
};

export function registerSettingsHandlers(): void {
  ipcMain.handle(CH.settingsGet, (_e, key: string): string | null => {
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? DEFAULTS[key] ?? null;
  });

  ipcMain.handle(CH.settingsSet, (_e, key: string, value: string): void => {
    getDb()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  });

  ipcMain.handle(CH.settingsAll, (): Record<string, string> => {
    const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, string> = { ...DEFAULTS };
    for (const r of rows) out[r.key] = r.value;
    return out;
  });

  ipcMain.handle(CH.settingsReset, (): void => {
    getDb().prepare('DELETE FROM settings').run();
  });
}
