import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app } from 'electron';
import log from 'electron-log';
import { getFFmpegPath } from './ffmpeg.service';
import type { CaptionSegment, CaptionWord } from '../../shared/types';

function whisperBinaryPath(): string {
  const resourceRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'whisper')
    : path.join(app.getAppPath(), 'resources');
  const bin = process.platform === 'win32' ? 'whisper.exe' : 'whisper';
  return path.join(resourceRoot, bin);
}

function whisperModelPath(): string {
  const resourceRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'whisper')
    : path.join(app.getAppPath(), 'resources');
  return path.join(resourceRoot, 'ggml-base.en.bin');
}

export function isWhisperAvailable(): boolean {
  return fs.existsSync(whisperBinaryPath()) && fs.existsSync(whisperModelPath());
}

async function extractWav(sourcePath: string, wavPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFFmpegPath(), [
      '-y',
      '-i',
      sourcePath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      wavPath,
    ]);
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`wav extract failed: ${err.slice(-1000)}`))));
    proc.on('error', reject);
  });
}

let currentProc: ChildProcess | null = null;

export async function transcribe(
  sourcePath: string,
  onProgress?: (percent: number) => void,
): Promise<CaptionSegment[]> {
  if (!isWhisperAvailable()) {
    throw new Error(
      'Whisper is not available. Place a whisper.cpp binary at resources/whisper and ggml-base.en.bin alongside it.',
    );
  }
  const tmpWav = path.join(os.tmpdir(), `snipette-whisper-${Date.now()}.wav`);
  await extractWav(sourcePath, tmpWav);

  return new Promise((resolve, reject) => {
    // `--output-json-full` includes per-token timestamps inside each segment, which we
    // need for word-level karaoke captions. Falls back gracefully when the build doesn't
    // expose tokens — the parser below treats `tokens` as optional.
    const args = ['-m', whisperModelPath(), '-f', tmpWav, '--output-json-full', '-pp'];
    const proc = spawn(whisperBinaryPath(), args);
    currentProc = proc;
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      // Some whisper.cpp builds emit progress lines on stdout — others stderr.
      const line = chunk.toString();
      const m = line.match(/(\d+)%/);
      if (m && onProgress) onProgress(parseInt(m[1]));
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const m = chunk.toString().match(/(\d+)%/);
      if (m && onProgress) onProgress(parseInt(m[1]));
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      currentProc = null;
      if (code !== 0) {
        cleanup(tmpWav);
        return reject(new Error(`whisper exited ${code}: ${stderr.slice(-1000)}`));
      }
      const jsonPath = `${tmpWav}.json`;
      try {
        if (!fs.existsSync(jsonPath)) {
          throw new Error(`whisper output JSON missing at ${jsonPath}`);
        }
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        type TokenJson = {
          text?: string;
          offsets?: { from?: number; to?: number };
          t0?: number;
          t1?: number;
        };
        type SegmentJson = {
          offsets?: { from?: number; to?: number };
          t0?: number;
          t1?: number;
          text?: string;
          tokens?: TokenJson[];
        };
        const parsed = JSON.parse(raw) as {
          transcription?: SegmentJson[];
          segments?: SegmentJson[];
        };
        const segs = parsed.transcription ?? parsed.segments ?? [];
        const out: CaptionSegment[] = segs.map((s) => {
          const t0 = s.offsets?.from ?? s.t0 ?? 0;
          const t1 = s.offsets?.to ?? s.t1 ?? t0;
          const segStart = typeof t0 === 'number' ? t0 : 0;
          const segEnd = typeof t1 === 'number' ? t1 : segStart;
          const words = parseWords(s.tokens ?? [], segStart, segEnd);
          return {
            startMs: segStart,
            endMs: segEnd,
            text: (s.text ?? '').trim(),
            confidence: 1,
            words: words.length > 0 ? words : undefined,
          };
        });
        cleanup(tmpWav);
        resolve(out);
      } catch (e) {
        cleanup(tmpWav);
        reject(e);
      }
    });
  });
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      const j = `${p}.json`;
      if (fs.existsSync(j)) fs.unlinkSync(j);
    } catch (e) {
      log.warn('whisper cleanup failed', e);
    }
  }
}

/**
 * Group whisper tokens into whole words. Whisper.cpp emits BPE-style subtokens
 * (e.g. "Hel", "lo", " world"), and a new word generally starts whenever a token
 * begins with whitespace. We accumulate text + take the earliest t0 and latest t1
 * across the merged subtokens. Special tokens like `[_BEG_]`, `[_TT_*]` are skipped.
 */
function parseWords(
  tokens: { text?: string; offsets?: { from?: number; to?: number }; t0?: number; t1?: number }[],
  fallbackStart: number,
  fallbackEnd: number,
): CaptionWord[] {
  const words: CaptionWord[] = [];
  let cur: { text: string; startMs: number; endMs: number } | null = null;

  for (const tok of tokens) {
    const text = tok.text ?? '';
    if (!text) continue;
    // Skip whisper.cpp special markers — they're metadata, not transcription.
    if (text.startsWith('[_') && text.endsWith(']')) continue;
    const start = tok.offsets?.from ?? tok.t0 ?? fallbackStart;
    const end = tok.offsets?.to ?? tok.t1 ?? start;
    const startsNewWord = /^\s/.test(text) || cur === null;
    if (startsNewWord) {
      if (cur && cur.text.trim().length > 0) words.push({ ...cur, text: cur.text.trim() });
      cur = { text, startMs: start, endMs: end };
    } else {
      cur.text += text;
      cur.endMs = Math.max(cur.endMs, end);
    }
  }
  if (cur && cur.text.trim().length > 0) words.push({ ...cur, text: cur.text.trim() });

  // Defensive: if every word ended up with the same start/end as the segment,
  // we have no useful timing info — let the caller fall back to synthetic split.
  if (words.length > 0 && words.every((w) => w.startMs === fallbackStart && w.endMs === fallbackEnd)) {
    return [];
  }
  return words;
}

export function cancelTranscription(): void {
  if (currentProc) {
    currentProc.kill('SIGTERM');
    currentProc = null;
  }
}
