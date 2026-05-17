import { ipcMain, BrowserWindow } from 'electron';
import log from 'electron-log';
import { CH } from '../../shared/types';
import {
  createSnapshot,
  exportBundle,
  listSnapshots,
  restoreSnapshot,
  type ExportBundleResult,
  type Snapshot,
} from '../services/backup.service';
import { closeDatabase, initDatabase } from '../services/db.service';

export function registerBackupHandlers(_getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    CH.backupCreateSnapshot,
    async (_e, projectId: string): Promise<Snapshot> => {
      return createSnapshot(projectId);
    },
  );

  ipcMain.handle(
    CH.backupListSnapshots,
    async (_e, projectId: string): Promise<Snapshot[]> => {
      return listSnapshots(projectId);
    },
  );

  ipcMain.handle(
    CH.backupRestoreSnapshot,
    async (_e, snapshotPath: string): Promise<void> => {
      // The DB must be closed before the file is swapped, then reopened so the rest of
      // the app sees the new contents on the next query.
      closeDatabase();
      try {
        await restoreSnapshot(snapshotPath);
      } catch (e) {
        // Re-open whatever DB still exists so the app remains usable.
        try {
          initDatabase();
        } catch (initErr) {
          log.error('[backup] failed to re-open DB after restore error', initErr);
        }
        throw e;
      }
      initDatabase();
    },
  );

  ipcMain.handle(
    CH.backupExportBundle,
    async (_e, projectId: string, outputPath: string): Promise<ExportBundleResult> => {
      return exportBundle(projectId, outputPath);
    },
  );
}
