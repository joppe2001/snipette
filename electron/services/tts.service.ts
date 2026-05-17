/**
 * Text-to-speech using the macOS `say` command. Produces an AIFF, then converts to
 * AAC/M4A via the bundled FFmpeg so the resulting clip plays everywhere we need
 * (preview <audio>, FFmpeg export chain).
 *
 * Linux/Windows fallback is intentionally limited — those platforms don't ship a
 * comparable CLI by default. We throw a clear error there so the Dialogue panel can
 * grey out the TTS option rather than failing silently.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import { v4 as uuid } from 'uuid';
import log from 'electron-log';
import { getFFmpegPath } from './ffmpeg.service';

export interface SpeakOpts {
  text: string;
  voice?: string;
  rate?: number;
}

export interface VoiceInfo {
  name: string;
  locale: string;
}

function ttsDir(): string {
  const dir = path.join(app.getPath('userData'), 'tts');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runProc(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/**
 * Generate a TTS audio file. Returns the absolute path of the finished `.m4a`. Cleans
 * up the intermediate AIFF on the way out.
 */
export async function speakToFile(opts: SpeakOpts): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error(
      'Built-in TTS requires macOS (`say` command). Use the Voice Studio to record manually.',
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const aiff = path.join(ttsDir(), `tts_${stamp}_${uuid().slice(0, 6)}.aiff`);
  const m4a = aiff.replace(/\.aiff$/, '.m4a');

  const sayArgs: string[] = ['-o', aiff];
  if (opts.voice) sayArgs.push('-v', opts.voice);
  if (opts.rate) sayArgs.push('-r', String(Math.max(60, Math.min(400, Math.round(opts.rate)))));
  // Pass text after flags as the final positional arg so spaces / punctuation are kept.
  sayArgs.push(opts.text);

  await runProc('say', sayArgs);

  // Convert AIFF → M4A/AAC for storage in the library.
  await runProc(getFFmpegPath(), [
    '-y',
    '-i',
    aiff,
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    m4a,
  ]);

  try {
    await fs.promises.unlink(aiff);
  } catch {
    // ignore — intermediate cleanup is best-effort
  }
  log.info(`[tts] generated ${m4a} (voice=${opts.voice ?? 'default'})`);
  return m4a;
}

/**
 * List available system voices. macOS lines look like:
 *   Alex                en_US    # Most people recognize me by my voice.
 * We split on whitespace and grab the first two columns.
 */
export async function listVoices(): Promise<VoiceInfo[]> {
  if (process.platform !== 'darwin') return [];
  return new Promise<VoiceInfo[]>((resolve, reject) => {
    const proc = spawn('say', ['-v', '?']);
    let buf = '';
    proc.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
    });
    proc.on('error', reject);
    proc.on('close', () => {
      const voices: VoiceInfo[] = [];
      for (const raw of buf.split('\n')) {
        const line = raw.trimEnd();
        if (!line) continue;
        // Match the name (everything up to 2+ spaces) and the locale token after it.
        const m = line.match(/^(.+?)\s{2,}([a-z]{2,3}_[A-Z]{2,3})\b/);
        if (!m) continue;
        voices.push({ name: m[1].trim(), locale: m[2] });
      }
      // De-dup by name (some installs list the same voice multiple times).
      const seen = new Set<string>();
      const uniq = voices.filter((v) => {
        if (seen.has(v.name)) return false;
        seen.add(v.name);
        return true;
      });
      resolve(uniq);
    });
  });
}
