// Pure color-space conversions used by the custom ColorPicker.
// No React / DOM dependencies — safe to import anywhere.

export interface RGB {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
}

export interface HSV {
  h: number; // 0-360
  s: number; // 0-1
  v: number; // 0-1
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function roundChannel(n: number): number {
  return clamp(Math.round(n), 0, 255);
}

function toHexByte(n: number): string {
  return roundChannel(n).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Strip a leading `#`, accept 3- or 6-digit forms, and return a canonical
 * `#RRGGBB` uppercase string. Returns null when the input is malformed.
 */
export function normalizeHex(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/^#/, '');
  if (trimmed.length === 3) {
    if (!/^[0-9a-fA-F]{3}$/.test(trimmed)) return null;
    const [r, g, b] = trimmed.split('');
    return `#${(r + r + g + g + b + b).toUpperCase()}`;
  }
  if (trimmed.length === 6) {
    if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return null;
    return `#${trimmed.toUpperCase()}`;
  }
  return null;
}

export function hexToRgb(hex: string): RGB | null {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  return { r, g, b };
}

export function rgbToHex(rgb: RGB): string {
  return `#${toHexByte(rgb.r)}${toHexByte(rgb.g)}${toHexByte(rgb.b)}`;
}

export function clampRgb(rgb: RGB): RGB {
  return {
    r: roundChannel(rgb.r),
    g: roundChannel(rgb.g),
    b: roundChannel(rgb.b),
  };
}

export function rgbToHsv(rgb: RGB): HSV {
  const r = clamp(rgb.r, 0, 255) / 255;
  const g = clamp(rgb.g, 0, 255) / 255;
  const b = clamp(rgb.b, 0, 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta > 0) {
    if (max === r) {
      h = ((g - b) / delta) % 6;
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : delta / max;
  const v = max;

  return { h, s, v };
}

export function hsvToRgb(hsv: HSV): RGB {
  const h = ((hsv.h % 360) + 360) % 360;
  const s = clamp(hsv.s, 0, 1);
  const v = clamp(hsv.v, 0, 1);

  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) {
    r1 = c; g1 = x; b1 = 0;
  } else if (hp < 2) {
    r1 = x; g1 = c; b1 = 0;
  } else if (hp < 3) {
    r1 = 0; g1 = c; b1 = x;
  } else if (hp < 4) {
    r1 = 0; g1 = x; b1 = c;
  } else if (hp < 5) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  const m = v - c;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}
