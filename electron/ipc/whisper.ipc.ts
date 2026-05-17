import { ipcMain, BrowserWindow } from 'electron';
import { CH } from '../../shared/types';
import type { CaptionSegment, MediaAsset } from '../../shared/types';
import { getDb } from '../services/db.service';
import { cancelTranscription, transcribe } from '../services/whisper.service';

export function registerCaptionsHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CH.captionsTranscribe, async (_e, assetId: string): Promise<CaptionSegment[]> => {
    const db = getDb();
    const asset = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(assetId) as MediaAsset | undefined;
    if (!asset) throw new Error(`Asset ${assetId} not found`);
    return transcribe(asset.original_path, (percent) => {
      const w = getWindow();
      if (w && !w.isDestroyed()) w.webContents.send(CH.captionsProgressEvent, { percent });
    });
  });

  ipcMain.handle(CH.captionsCancel, async (): Promise<void> => {
    cancelTranscription();
  });
}
