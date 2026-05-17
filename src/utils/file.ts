export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let v = bytes;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v > 100 ? 0 : 1)} ${units[i]}`;
}

export function fileUrl(absolutePath: string): string {
  // Renderer can't read the filesystem directly, but we register a `snipette-file://` protocol
  // in main that streams arbitrary user file paths back to the renderer.
  //
  // The URL needs to have a real host (`local`) — Chromium's URL-safety check rejects media
  // loads from "opaque" origins (empty host on a standard scheme). We also use `encodeURI` so
  // slashes stay literal (`/Users/...`) rather than being percent-encoded into `%2F`, which
  // some Chromium safety paths treat as suspicious.
  const normalized = absolutePath.replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `snipette-file://local${encodeURI(withSlash)}`;
}

export function basename(p: string): string {
  const last = p.replace(/\\/g, '/').split('/').pop() ?? p;
  return last;
}

export function extname(p: string): string {
  const b = basename(p);
  const idx = b.lastIndexOf('.');
  return idx >= 0 ? b.slice(idx) : '';
}

export function isVideoPath(p: string): boolean {
  return ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'].includes(extname(p).toLowerCase());
}
export function isAudioPath(p: string): boolean {
  return ['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus'].includes(extname(p).toLowerCase());
}
export function isImagePath(p: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic'].includes(extname(p).toLowerCase());
}
