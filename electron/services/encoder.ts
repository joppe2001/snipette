/**
 * Encoder service — hardware acceleration detection plus a single source of truth
 * for ffmpeg encoder args. The export pipeline (electron/ipc/export.ipc.ts) calls
 * `buildEncoderArgs` once after the filter graph is constructed, replacing the
 * old `qualityToEncoderArgs` + `formatToContainerArgs` pair.
 *
 * HW accel detection runs `ffmpeg -hwaccels` lazily on first request and caches
 * the result — we never block startup on it.
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import log from 'electron-log';
import { getFFmpegPath } from './ffmpeg.service';

export type ExportFormat = 'mp4' | 'mp4-h265' | 'mov' | 'webm' | 'gif';
export type ExportQuality = 'draft' | 'good' | 'high' | 'best' | 'lossless';
export type HwAccelMode = 'auto' | 'videotoolbox' | 'nvenc' | 'qsv' | 'vaapi' | 'none';

export interface AdvancedEncoderOpts {
  format: ExportFormat;
  quality: ExportQuality;
  /** When set, overrides quality-derived bitrate. Bits per second. */
  targetBitrate?: number;
  /** 2-pass encoding produces smaller files at same quality; takes 2x as long. */
  twoPass?: boolean;
  /** Which hardware encoder to use; 'auto' = best available, 'none' = software. */
  hwAccel?: HwAccelMode;
  /** Normalize audio loudness to EBU R128 (-16 LUFS). */
  normalizeLoudness?: boolean;
  /** H.264 profile. */
  profile?: 'baseline' | 'main' | 'high';
  /** Encoder level, e.g. '4.1', '5.1'. */
  level?: string;
  /** Pixel format. yuv420p = 8-bit (most compatible); yuv420p10le = 10-bit (HDR-ish). */
  pixelFormat?: 'yuv420p' | 'yuv420p10le';
  /** Target FPS — only used to encode -r before the output path. */
  fps?: number;
  /** Whether the export should include audio (drives -an vs `-c:a`). */
  includeAudio?: boolean;
}

export interface BuiltEncoderArgs {
  /** Args appended after `-map` (replaces both `qualityToEncoderArgs` + `formatToContainerArgs`). */
  args: string[];
  /** When two-pass is requested, the two command arrays (already include their own output). */
  twoPassCmd: { pass1: string[]; pass2: string[] } | null;
}

/** Codec families. */
type VideoCodecFamily = 'h264' | 'h265' | 'vp9' | 'gif';

interface ResolvedCodec {
  /** ffmpeg encoder name, e.g. `libx264`, `h264_videotoolbox`, `hevc_nvenc`. */
  name: string;
  /** Whether the resolved encoder is a hardware encoder (no CRF support). */
  isHardware: boolean;
  family: VideoCodecFamily;
  /** The HW accel mode that was chosen (after `pickHwAccel` resolved 'auto'). */
  hwAccel: HwAccelMode;
}

// ---------------------------------------------------------------------------
// HW accel detection (lazy + cached)
// ---------------------------------------------------------------------------

let cachedAccels: Set<HwAccelMode> | null = null;

/**
 * Runs `ffmpeg -hwaccels` once, parses the output, caches the set of available
 * hardware acceleration methods (videotoolbox, nvenc, qsv, vaapi, …). Safe to
 * call from any thread — synchronous and idempotent.
 */
export function detectAvailableHwAccels(): Set<HwAccelMode> {
  if (cachedAccels) return cachedAccels;

  const accels = new Set<HwAccelMode>();
  try {
    const result = spawnSync(getFFmpegPath(), ['-hide_banner', '-hwaccels'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (result.status === 0 && typeof result.stdout === 'string') {
      // Output format:
      //   Hardware acceleration methods:
      //   videotoolbox
      //   qsv
      //   …
      const lines = result.stdout.split('\n');
      for (const raw of lines) {
        const line = raw.trim().toLowerCase();
        if (!line || line.endsWith(':')) continue;
        if (
          line === 'videotoolbox' ||
          line === 'nvenc' ||
          line === 'cuda' ||
          line === 'qsv' ||
          line === 'vaapi'
        ) {
          // Treat cuda hwaccel as a proxy for nvenc availability.
          if (line === 'cuda') accels.add('nvenc');
          else accels.add(line as HwAccelMode);
        }
      }
    } else {
      log.warn('[encoder] ffmpeg -hwaccels returned non-zero', result.status);
    }
  } catch (e) {
    log.warn('[encoder] failed to probe hwaccels', e instanceof Error ? e.message : e);
  }

  cachedAccels = accels;
  return cachedAccels;
}

/**
 * Pick a concrete HwAccelMode from the user's request. 'auto' is resolved to the
 * best available accel for the current platform; specific modes are validated
 * against the detected set (falling back to 'none' if missing).
 */
export function pickHwAccel(mode: HwAccelMode): HwAccelMode {
  if (mode === 'none') return 'none';
  const available = detectAvailableHwAccels();

  if (mode === 'auto') {
    const platform = process.platform;
    const priority: HwAccelMode[] =
      platform === 'darwin'
        ? ['videotoolbox']
        : platform === 'win32'
          ? ['nvenc', 'qsv']
          : platform === 'linux'
            ? ['vaapi', 'nvenc', 'qsv']
            : [];
    for (const candidate of priority) {
      if (available.has(candidate)) return candidate;
    }
    return 'none';
  }

  return available.has(mode) ? mode : 'none';
}

// ---------------------------------------------------------------------------
// Quality tables
// ---------------------------------------------------------------------------

export const QUALITY_CRF: Record<ExportQuality, number> = {
  draft: 28,
  good: 23,
  high: 20,
  best: 18,
  lossless: 0,
};

export const QUALITY_BITRATE_MBPS: Record<ExportQuality, number> = {
  draft: 3,
  good: 6,
  high: 12,
  best: 20,
  lossless: 80,
};

const QUALITY_PRESET: Record<ExportQuality, string> = {
  draft: 'veryfast',
  good: 'fast',
  high: 'medium',
  best: 'slow',
  lossless: 'medium',
};

// ---------------------------------------------------------------------------
// Codec resolution
// ---------------------------------------------------------------------------

function formatToFamily(format: ExportFormat): VideoCodecFamily {
  switch (format) {
    case 'mp4-h265':
      return 'h265';
    case 'webm':
      return 'vp9';
    case 'gif':
      return 'gif';
    case 'mp4':
    case 'mov':
    default:
      return 'h264';
  }
}

function resolveCodec(format: ExportFormat, requestedAccel: HwAccelMode): ResolvedCodec {
  const family = formatToFamily(format);

  // GIF and VP9 don't have HW-accel paths we want to expose here; force software.
  if (family === 'gif') {
    return { name: 'gif', isHardware: false, family, hwAccel: 'none' };
  }
  if (family === 'vp9') {
    return { name: 'libvpx-vp9', isHardware: false, family, hwAccel: 'none' };
  }

  const accel = pickHwAccel(requestedAccel);

  if (family === 'h264') {
    switch (accel) {
      case 'videotoolbox':
        return { name: 'h264_videotoolbox', isHardware: true, family, hwAccel: accel };
      case 'nvenc':
        return { name: 'h264_nvenc', isHardware: true, family, hwAccel: accel };
      case 'qsv':
        return { name: 'h264_qsv', isHardware: true, family, hwAccel: accel };
      case 'vaapi':
        return { name: 'h264_vaapi', isHardware: true, family, hwAccel: accel };
      default:
        return { name: 'libx264', isHardware: false, family, hwAccel: 'none' };
    }
  }

  // family === 'h265'
  switch (accel) {
    case 'videotoolbox':
      return { name: 'hevc_videotoolbox', isHardware: true, family, hwAccel: accel };
    case 'nvenc':
      return { name: 'hevc_nvenc', isHardware: true, family, hwAccel: accel };
    case 'qsv':
      return { name: 'hevc_qsv', isHardware: true, family, hwAccel: accel };
    case 'vaapi':
      return { name: 'hevc_vaapi', isHardware: true, family, hwAccel: accel };
    default:
      return { name: 'libx265', isHardware: false, family, hwAccel: 'none' };
  }
}

// ---------------------------------------------------------------------------
// Args builders
// ---------------------------------------------------------------------------

function nullOutputTarget(): string {
  // Pass-1 of two-pass encoding writes to a null sink — platform-dependent path.
  return os.platform() === 'win32' ? 'NUL' : '/dev/null';
}

function nullOutputFormat(): string {
  // `-f null` is correct on all platforms; pair with the platform-specific target above.
  return 'null';
}

/**
 * Bitrate (bps) derived from quality + optional explicit override.
 */
function resolveBitrate(quality: ExportQuality, targetBitrate?: number): number {
  if (targetBitrate && targetBitrate > 0) return Math.floor(targetBitrate);
  return Math.floor(QUALITY_BITRATE_MBPS[quality] * 1_000_000);
}

function audioCodecArgs(format: ExportFormat, includeAudio: boolean, normalize: boolean): string[] {
  if (!includeAudio) return ['-an'];
  // Loudness normalization is appended BEFORE -c:a so it applies to the mapped
  // [afinal] stream. -af is a global filter pre-encode.
  const lufs = normalize ? ['-af', 'loudnorm=I=-16:LRA=11:TP=-1.5'] : [];
  if (format === 'webm') {
    return [...lufs, '-c:a', 'libopus', '-b:a', '128k'];
  }
  return [...lufs, '-c:a', 'aac', '-b:a', '192k'];
}

function containerExtras(format: ExportFormat): string[] {
  switch (format) {
    case 'mp4-h265':
      return ['-tag:v', 'hvc1', '-movflags', '+faststart'];
    case 'mp4':
    case 'mov':
      return ['-movflags', '+faststart'];
    case 'webm':
      return [];
    case 'gif':
      return ['-loop', '0'];
    default:
      return [];
  }
}

function videoRateControlArgs(
  codec: ResolvedCodec,
  quality: ExportQuality,
  targetBitrate: number | undefined,
): string[] {
  // VP9: keep the existing tuning (CRF-VBR with -b:v 0).
  if (codec.family === 'vp9') {
    if (targetBitrate && targetBitrate > 0) {
      return ['-b:v', `${targetBitrate}`];
    }
    return ['-b:v', '0', '-crf', '30'];
  }

  // GIF: no rate-control args.
  if (codec.family === 'gif') {
    return [];
  }

  // Hardware encoders: prefer bitrate control. CRF is not universally supported
  // (videotoolbox supports it intermittently; nvenc/qsv use bitrate or CQ).
  if (codec.isHardware) {
    const bitrate = resolveBitrate(quality, targetBitrate);
    return ['-b:v', `${bitrate}`, '-maxrate', `${Math.floor(bitrate * 1.5)}`, '-bufsize', `${bitrate * 2}`];
  }

  // Software (libx264/libx265): if user pinned a bitrate, use it; otherwise CRF.
  if (targetBitrate && targetBitrate > 0) {
    return ['-b:v', `${targetBitrate}`, '-preset', QUALITY_PRESET[quality]];
  }
  return ['-crf', `${QUALITY_CRF[quality]}`, '-preset', QUALITY_PRESET[quality]];
}

function profileLevelPixfmtArgs(
  codec: ResolvedCodec,
  profile: AdvancedEncoderOpts['profile'],
  level: string | undefined,
  pixelFormat: AdvancedEncoderOpts['pixelFormat'],
): string[] {
  const out: string[] = [];

  // H.264 supports baseline/main/high; H.265 supports main/main10.
  if (codec.family === 'h264' && profile) {
    out.push('-profile:v', profile);
  } else if (codec.family === 'h265') {
    // For h265 + 10-bit, switch the profile to main10 to keep ffmpeg happy.
    if (pixelFormat === 'yuv420p10le') {
      out.push('-profile:v', 'main10');
    }
  }

  if ((codec.family === 'h264' || codec.family === 'h265') && level) {
    out.push('-level', level);
  }

  // Pixel format — only meaningful for H.264/H.265 in this UI.
  if ((codec.family === 'h264' || codec.family === 'h265') && pixelFormat) {
    out.push('-pix_fmt', pixelFormat);
  }

  return out;
}

/**
 * Build the encoder args block for a single-pass export.
 * Does NOT include audio args or container extras — those are handled by callers.
 */
function buildVideoEncoderBlock(
  codec: ResolvedCodec,
  opts: AdvancedEncoderOpts,
): string[] {
  const args: string[] = ['-c:v', codec.name];
  args.push(...videoRateControlArgs(codec, opts.quality, opts.targetBitrate));
  args.push(...profileLevelPixfmtArgs(codec, opts.profile, opts.level, opts.pixelFormat));
  return args;
}

/**
 * Build the full ffmpeg args list — meant to be appended directly after `-map` calls.
 *
 * The returned `args` block intentionally does NOT include the leading `-y`, the inputs,
 * or `-filter_complex`/`-map`. It only covers:
 *   - video codec + rate control + profile/level/pixfmt
 *   - audio codec (or `-an`) + optional loudnorm `-af`
 *   - container extras (`-movflags +faststart`, `-tag:v hvc1`, …)
 *   - FPS (`-r`)
 *
 * When `twoPass` is requested, `twoPassCmd` is non-null and contains COMPLETE
 * pass-1/pass-2 ffmpeg arg lists (minus the input/`filter_complex`/`map` block,
 * which the caller still prepends). The caller is expected to splice these in
 * place of `args` and orchestrate the two spawn() calls itself.
 */
export function buildEncoderArgs(
  opts: AdvancedEncoderOpts,
  _durationS: number,
  includeAudio: boolean,
): BuiltEncoderArgs {
  const codec = resolveCodec(opts.format, opts.hwAccel ?? 'auto');
  const normalize = !!opts.normalizeLoudness;
  const fps = opts.fps;

  const videoBlock = buildVideoEncoderBlock(codec, opts);
  const audioBlock = audioCodecArgs(opts.format, includeAudio, normalize);
  const container = containerExtras(opts.format);
  const fpsArgs = fps ? ['-r', `${fps}`] : [];

  // GIF has no audio support; collapse to -an regardless of includeAudio.
  const audio = opts.format === 'gif' ? ['-an'] : audioBlock;

  const args: string[] = [...videoBlock, ...audio, ...fpsArgs, ...container];

  // Two-pass — only sensible for software encoders with bitrate control.
  // For HW encoders we silently skip the two-pass dance (it doesn't help quality).
  let twoPassCmd: BuiltEncoderArgs['twoPassCmd'] = null;
  if (opts.twoPass && !codec.isHardware && codec.family !== 'gif') {
    const passlogPrefix = `snipette-2pass-${Date.now()}`;
    // Pass 1: re-derive a bitrate (CRF doesn't apply to two-pass).
    const bitrate = resolveBitrate(opts.quality, opts.targetBitrate);
    const pass1Video = [
      '-c:v',
      codec.name,
      '-b:v',
      `${bitrate}`,
      '-pass',
      '1',
      '-passlogfile',
      passlogPrefix,
      '-preset',
      QUALITY_PRESET[opts.quality],
    ];
    pass1Video.push(
      ...profileLevelPixfmtArgs(codec, opts.profile, opts.level, opts.pixelFormat),
    );

    const pass2Video = [
      '-c:v',
      codec.name,
      '-b:v',
      `${bitrate}`,
      '-pass',
      '2',
      '-passlogfile',
      passlogPrefix,
      '-preset',
      QUALITY_PRESET[opts.quality],
    ];
    pass2Video.push(
      ...profileLevelPixfmtArgs(codec, opts.profile, opts.level, opts.pixelFormat),
    );

    twoPassCmd = {
      pass1: [
        ...pass1Video,
        '-an',
        ...fpsArgs,
        '-f',
        nullOutputFormat(),
        nullOutputTarget(),
      ],
      pass2: [...pass2Video, ...audio, ...fpsArgs, ...container],
    };
  }

  return { args, twoPassCmd };
}
