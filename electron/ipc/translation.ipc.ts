import { ipcMain, BrowserWindow } from 'electron';
import { CH } from '../../shared/types';
import type { CaptionSegment, OllamaModel, TranslateOpts } from '../../shared/types';
import {
  cancelTranslation,
  isOllamaAvailable,
  listOllamaModels,
  translateSegments,
} from '../services/ollama.service';

export function registerTranslationHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CH.ollamaAvailable, async (): Promise<boolean> => isOllamaAvailable());

  ipcMain.handle(CH.ollamaListModels, async (): Promise<OllamaModel[]> => listOllamaModels());

  ipcMain.handle(
    CH.captionsTranslate,
    async (_e, segments: CaptionSegment[], opts: TranslateOpts): Promise<CaptionSegment[]> => {
      return translateSegments(segments, opts, (p) => {
        const w = getWindow();
        if (w && !w.isDestroyed()) w.webContents.send(CH.captionsTranslateProgressEvent, p);
      });
    },
  );

  ipcMain.handle(CH.captionsTranslateCancel, async (): Promise<void> => {
    cancelTranslation();
  });
}
