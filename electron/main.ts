import { app, BrowserWindow, shell, protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';

// Must run BEFORE app.ready or <video>/<audio> tags will refuse to load from this scheme.
// Tells Chromium our scheme is HTTP-equivalent (standard URL parsing, streaming, secure context).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'snipette-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
import log from 'electron-log';
import { initDatabase, closeDatabase } from './services/db.service';
import { registerProjectHandlers } from './ipc/project.ipc';
import { registerMediaHandlers } from './ipc/media.ipc';
import { registerTimelineHandlers } from './ipc/timeline.ipc';
import { registerExportHandlers } from './ipc/export.ipc';
import { registerCaptionsHandlers } from './ipc/whisper.ipc';
import { registerSettingsHandlers } from './ipc/settings.ipc';
import { registerSystemHandlers } from './ipc/system.ipc';
import { registerBackupHandlers } from './ipc/backup.ipc';
import { registerWebExportHandlers } from './ipc/web-export.ipc';
import { registerVoiceRecordingHandlers } from './ipc/voice-recording.ipc';
import { registerTtsHandlers } from './ipc/tts.ipc';
import { registerTranslationHandlers } from './ipc/translation.ipc';

log.transports.file.level = 'info';
log.transports.console.level = 'debug';

let mainWindow: BrowserWindow | null = null;

const isDev = !app.isPackaged;

function getUserDataDir(): string {
  return app.getPath('userData');
}

function ensureDirs() {
  const root = getUserDataDir();
  const dirs = ['projects', 'media', 'proxies', 'thumbnails', 'waveforms', 'cache', 'exports'];
  for (const d of dirs) {
    const p = path.join(root, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function registerLocalFileProtocol() {
  // `snipette-file://...` — CSP-safe loader for user-imported media. Implements explicit
  // Range support so <video>/<audio> can stream + seek without loading the whole file.
  protocol.handle('snipette-file', async (request) => {
    try {
      const url = new URL(request.url);
      // With the new URL shape `snipette-file://local/Users/.../file.mp4`, `url.pathname` is the
      // file path with a leading slash and percent-encoded special chars (decodeURI handles those
      // while leaving slashes alone).
      const decoded = decodeURI(url.pathname);
      const abs = path.normalize(decoded);
      if (!fs.existsSync(abs)) {
        log.warn('[snipette-file] not found', abs);
        return new Response('not found', { status: 404 });
      }
      const stat = fs.statSync(abs);
      const size = stat.size;
      const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
      const rangeHeader = request.headers.get('range');

      if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (!m) return new Response('bad range', { status: 416 });
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
        if (start > end || start >= size) {
          return new Response('range not satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` },
          });
        }
        const nodeStream = fs.createReadStream(abs, { start, end });
        return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
          },
        });
      }

      const nodeStream = fs.createReadStream(abs);
      return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (e) {
      log.error('snipette-file protocol error', e);
      return new Response('error', { status: 500 });
    }
  });
}

async function createMainWindow() {
  const preloadPath = path.join(__dirname, '../preload/preload.js');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: '#0a0a0c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  ensureDirs();
  registerLocalFileProtocol();
  initDatabase();

  registerProjectHandlers(() => mainWindow);
  registerMediaHandlers(() => mainWindow);
  registerTimelineHandlers();
  registerExportHandlers(() => mainWindow);
  registerCaptionsHandlers(() => mainWindow);
  registerSettingsHandlers();
  registerSystemHandlers();
  registerBackupHandlers(() => mainWindow);
  registerWebExportHandlers(() => mainWindow);
  registerVoiceRecordingHandlers(() => mainWindow);
  registerTtsHandlers(() => mainWindow);
  registerTranslationHandlers(() => mainWindow);

  await createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  closeDatabase();
  if (process.platform !== 'darwin') app.quit();
});

// Avoid leaking IPC across renderer crashes.
process.on('uncaughtException', (err) => log.error('uncaughtException', err));
process.on('unhandledRejection', (err) => log.error('unhandledRejection', err));

