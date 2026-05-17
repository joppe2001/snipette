import type { ColorGrade } from '@shared/types';

export const DEFAULT_GRADE: ColorGrade = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  sharpness: 0,
  vignette: 0,
  lut_path: null,
};

/**
 * Return a CSS `filter:` value that approximates a color grade — used in the preview canvas
 * for live feedback. Not byte-accurate vs. ffmpeg, but close enough for scrubbing.
 */
export function gradeToCSS(grade: Partial<ColorGrade>): string {
  const g = { ...DEFAULT_GRADE, ...grade };
  return [
    `brightness(${1 + g.exposure * 0.1})`,
    `contrast(${1 + g.contrast * 0.01})`,
    `saturate(${1 + g.saturation * 0.01})`,
    `hue-rotate(${g.temperature * 0.5}deg)`,
  ].join(' ');
}

export function isHex(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}
