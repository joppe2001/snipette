import { app, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { CH } from '../../shared/types';
import type { AppInfo, FilePickerOpts } from '../../shared/types';
import { isWhisperAvailable } from '../services/whisper.service';

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      } catch {
        // skip
      }
    }
  }
  return total;
}

export function registerSystemHandlers(): void {
  ipcMain.handle(CH.systemOpenInFinder, async (_e, p: string): Promise<void> => {
    if (fs.existsSync(p)) {
      shell.showItemInFolder(p);
    }
  });

  ipcMain.handle(CH.systemFilePicker, async (_e, opts: FilePickerOpts): Promise<string[]> => {
    if (opts.save) {
      const r = await dialog.showSaveDialog({
        title: opts.title,
        defaultPath: opts.defaultFileName ?? opts.defaultPath,
        filters: opts.filters,
      });
      return r.filePath ? [r.filePath] : [];
    }
    const properties: ('openFile' | 'openDirectory' | 'multiSelections')[] = opts.directory
      ? ['openDirectory']
      : ['openFile'];
    if (opts.multi) properties.push('multiSelections');
    const r = await dialog.showOpenDialog({
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
      properties,
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle(CH.systemFreeSpace, async (): Promise<number> => {
    try {
      const stat = fs.statfsSync(app.getPath('userData')) as unknown as {
        bavail: bigint;
        bsize: bigint;
      };
      return Number(stat.bavail * stat.bsize);
    } catch {
      return 0;
    }
  });

  ipcMain.handle(CH.systemCacheSize, async (): Promise<number> => {
    const root = app.getPath('userData');
    return (
      dirSize(path.join(root, 'thumbnails')) +
      dirSize(path.join(root, 'waveforms')) +
      dirSize(path.join(root, 'cache')) +
      dirSize(path.join(root, 'proxies'))
    );
  });

  ipcMain.handle(CH.systemClearCache, async (): Promise<void> => {
    const root = app.getPath('userData');
    for (const d of ['thumbnails', 'waveforms', 'cache']) {
      const p = path.join(root, d);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        fs.mkdirSync(p, { recursive: true });
      }
    }
  });

  ipcMain.handle(CH.systemAppInfo, async (): Promise<AppInfo> => ({
    version: app.getVersion(),
    platform: process.platform,
    user_data_path: app.getPath('userData'),
    cache_path: path.join(app.getPath('userData'), 'cache'),
  }));

  ipcMain.handle(CH.systemWhisperAvailable, async (): Promise<boolean> => isWhisperAvailable());
}
