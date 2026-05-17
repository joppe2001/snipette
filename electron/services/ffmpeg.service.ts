import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import log from 'electron-log';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegStatic = require('ffmpeg-static') as string;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobeStatic = require('ffprobe-static') as { path: string };
import type { MediaInfo, MediaType } from '../../shared/types';

function resolveBinary(input: string): string {
  // ffmpeg-static / ffprobe-static return a path that may be inside app.asar in production.
  // Electron's asarUnpack moves the binary to app.asar.unpacked — adjust the path so spawn works.
  if (app.isPackaged) {
    return input.replace('app.asar', 'app.asar.unpacked');
  }
  return input;
}

const FFMPEG_BIN = resolveBinary(ffmpegStatic);
const FFPROBE_BIN = resolveBinary(ffprobeStatic.path);

export function getFFmpegPath(): string {
  return FFMPEG_BIN;
}
export function getFFprobePath(): string {
  return FFPROBE_BIN;
}

function runFFprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE_BIN, args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`ffprobe exited ${code}: ${err}`));
    });
    proc.on('error', reject);
  });
}

export async function probeMedia(filePath: string): Promise<MediaInfo> {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const raw = await runFFprobe([
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    filePath,
  ]);
  const json = JSON.parse(raw) as {
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      duration?: string;
    }[];
    format?: { duration?: string; size?: string; bit_rate?: string };
  };
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const ext = path.extname(filePath).toLowerCase();
  const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.heic']);

  const isImage = imageExts.has(ext);
  const type: MediaType = isImage ? 'image' : video ? 'video' : 'audio';

  const durationS = parseFloat(json.format?.duration ?? video?.duration ?? '0') || 0;
  const fpsStr = video?.r_frame_rate ?? video?.avg_frame_rate ?? '0/1';
  const [num, den] = fpsStr.split('/').map(Number);
  const fps = den && den !== 0 ? num / den : 0;

  const stats = fs.statSync(filePath);
  return {
    type,
    duration_ms: isImage ? 5000 : Math.round(durationS * 1000),
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: fps || null,
    codec: video?.codec_name ?? audio?.codec_name ?? null,
    file_size: stats.size,
    has_audio: !!audio,
    has_video: !!video || isImage,
  };
}

export interface FFmpegRun {
  process: ChildProcess;
  done: Promise<void>;
}

function runFFmpeg(
  args: string[],
  opts?: { onProgress?: (line: string) => void },
): FFmpegRun {
  const proc = spawn(FFMPEG_BIN, args);
  let stderr = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString();
    stderr += line;
    opts?.onProgress?.(line);
  });

  const done = new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-2000)}`));
    });
    proc.on('error', reject);
  });

  return { process: proc, done };
}

/** Parse `time=HH:MM:SS.mmm` from ffmpeg stderr → seconds. */
export function parseFFmpegProgress(line: string): number | null {
  const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
}

export async function generateProxy(
  sourcePath: string,
  outputPath: string,
  durationMs: number,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const totalS = durationMs / 1000;
  const { done } = runFFmpeg(
    [
      '-y',
      '-i',
      sourcePath,
      '-vf',
      'scale=-2:540',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      outputPath,
    ],
    {
      onProgress: (line) => {
        const t = parseFFmpegProgress(line);
        if (t !== null && totalS > 0) {
          onProgress?.(Math.min(100, (t / totalS) * 100));
        }
      },
    },
  );
  await done;
}

export async function extractThumbnail(
  sourcePath: string,
  outputPath: string,
  timeMs: number,
  width = 320,
): Promise<void> {
  const ts = (timeMs / 1000).toFixed(3);
  const { done } = runFFmpeg([
    '-y',
    '-ss',
    ts,
    '-i',
    sourcePath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:-2`,
    outputPath,
  ]);
  await done;
}

/**
 * Extract a normalized [0..1] waveform array from an audio (or audio-bearing) file.
 * Implementation: ffmpeg → raw mono S16LE @ 8kHz to stdout → downsample to `samples` buckets.
 */
export async function extractWaveform(sourcePath: string, samples = 600): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, [
      '-i',
      sourcePath,
      '-ac',
      '1',
      '-ar',
      '8000',
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-',
    ]);
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c) => (stderr += c.toString()));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg waveform extract failed: ${stderr.slice(-1000)}`));
      }
      const buf = Buffer.concat(chunks);
      const total = Math.floor(buf.length / 2);
      if (total === 0) return resolve(new Array(samples).fill(0));
      const bucket = Math.max(1, Math.floor(total / samples));
      const out: number[] = [];
      let max = 0;
      for (let i = 0; i < samples; i++) {
        const start = i * bucket;
        let peak = 0;
        const end = Math.min(start + bucket, total);
        for (let j = start; j < end; j++) {
          const v = Math.abs(buf.readInt16LE(j * 2));
          if (v > peak) peak = v;
        }
        out.push(peak);
        if (peak > max) max = peak;
      }
      if (max === 0) return resolve(out);
      resolve(out.map((v) => v / max));
    });
    proc.on('error', reject);
  });
}

/** Run an arbitrary ffmpeg command — for the export pipeline. */
export function spawnFFmpeg(
  args: string[],
  onProgress?: (line: string) => void,
): FFmpegRun {
  log.info('[ffmpeg]', args.join(' '));
  return runFFmpeg(args, { onProgress });
}
