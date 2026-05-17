/**
 * Keyframe animation system. Animates clip properties (position, scale, rotation, opacity,
 * volume) over time by interpolating between user-placed keyframes.
 *
 * Storage: keyframes are stored inside the existing `clip.effects_json` array as a sentinel
 * entry `{ type: 'keyframes', tracks: { position_x: [...], ... } }`. This piggybacks on the
 * existing motion-FX serialization without bloating new columns. The motion-FX parser ignores
 * entries whose `type` isn't in its switch, so the two systems coexist safely.
 */

export type KeyframeProperty =
  | 'position_x'
  | 'position_y'
  | 'scale_x'
  | 'scale_y'
  | 'rotation'
  | 'opacity'
  | 'volume'
  | 'speed';

export interface KeyframePropertyMeta {
  key: KeyframeProperty;
  label: string;
  min: number;
  max: number;
  default: number;
  suffix?: string;
}

export const KEYFRAME_PROPERTIES: KeyframePropertyMeta[] = [
  { key: 'position_x', label: 'Position X', min: -1000, max: 1000, default: 0, suffix: 'px' },
  { key: 'position_y', label: 'Position Y', min: -1000, max: 1000, default: 0, suffix: 'px' },
  { key: 'scale_x', label: 'Scale X', min: 0.1, max: 4, default: 1 },
  { key: 'scale_y', label: 'Scale Y', min: 0.1, max: 4, default: 1 },
  { key: 'rotation', label: 'Rotation', min: -360, max: 360, default: 0, suffix: '°' },
  { key: 'opacity', label: 'Opacity', min: 0, max: 1, default: 1 },
  { key: 'volume', label: 'Volume', min: 0, max: 2, default: 1 },
  { key: 'speed', label: 'Speed', min: 0.25, max: 4, default: 1, suffix: '×' },
];

export type KeyframeEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold';

export interface Keyframe {
  /** Time relative to clip start, in milliseconds. */
  t: number;
  /** Value at this time. */
  v: number;
  /** How to interpolate FROM this keyframe to the next one. */
  easing?: KeyframeEasing;
}

export type KeyframeTracks = Partial<Record<KeyframeProperty, Keyframe[]>>;

/** Sentinel entry stored in effects_json so it coexists with motion-FX entries. */
export interface KeyframesEntry {
  type: 'keyframes';
  tracks: KeyframeTracks;
}

const KEYFRAME_PROPERTY_KEYS: ReadonlySet<KeyframeProperty> = new Set<KeyframeProperty>([
  'position_x',
  'position_y',
  'scale_x',
  'scale_y',
  'rotation',
  'opacity',
  'volume',
  'speed',
]);

function isKeyframeProperty(value: string): value is KeyframeProperty {
  return KEYFRAME_PROPERTY_KEYS.has(value as KeyframeProperty);
}

function isKeyframe(value: unknown): value is Keyframe {
  if (!value || typeof value !== 'object') return false;
  const k = value as { t?: unknown; v?: unknown };
  return typeof k.t === 'number' && typeof k.v === 'number';
}

/** Parse the keyframes sentinel out of effects_json. Returns an empty tracks object on any error. */
export function parseKeyframes(json: string | null | undefined): KeyframeTracks {
  if (!json) return {};
  try {
    const raw: unknown = JSON.parse(json);
    if (!Array.isArray(raw)) return {};
    const entry = raw.find(
      (e): e is KeyframesEntry =>
        !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'keyframes',
    );
    if (!entry || !entry.tracks || typeof entry.tracks !== 'object') return {};
    const tracks: KeyframeTracks = {};
    for (const key of Object.keys(entry.tracks)) {
      if (!isKeyframeProperty(key)) continue;
      const arr = (entry.tracks as Record<string, unknown>)[key];
      if (Array.isArray(arr)) {
        tracks[key] = arr.filter(isKeyframe).slice().sort((a, b) => a.t - b.t);
      }
    }
    return tracks;
  } catch {
    return {};
  }
}

/** Update the keyframes entry in effects_json, preserving other entries. */
export function writeKeyframes(effectsJson: string | null | undefined, tracks: KeyframeTracks): string {
  let arr: unknown[] = [];
  if (effectsJson) {
    try {
      const raw: unknown = JSON.parse(effectsJson);
      if (Array.isArray(raw)) arr = raw;
    } catch {
      /* ignore — start with empty array */
    }
  }
  const without = arr.filter(
    (e) => !(e && typeof e === 'object' && (e as { type?: unknown }).type === 'keyframes'),
  );
  // Only include tracks that have at least one keyframe.
  const cleanTracks: KeyframeTracks = {};
  let hasAny = false;
  for (const key of Object.keys(tracks) as KeyframeProperty[]) {
    const t = tracks[key];
    if (t && t.length > 0) {
      cleanTracks[key] = t.slice().sort((a, b) => a.t - b.t);
      hasAny = true;
    }
  }
  if (hasAny) {
    const entry: KeyframesEntry = { type: 'keyframes', tracks: cleanTracks };
    without.push(entry);
  }
  return JSON.stringify(without);
}

function easeFn(easing: KeyframeEasing | undefined, t: number): number {
  switch (easing) {
    case 'ease-in':
      return t * t;
    case 'ease-out':
      return 1 - (1 - t) * (1 - t);
    case 'ease-in-out':
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case 'hold':
      return 0;
    case 'linear':
    default:
      return t;
  }
}

/** Interpolated value of a property at the given clip-relative time. Returns null if no keyframes. */
export function valueAt(tracks: KeyframeTracks, prop: KeyframeProperty, relativeMs: number): number | null {
  const arr = tracks[prop];
  if (!arr || arr.length === 0) return null;
  if (arr.length === 1) return arr[0].v;
  if (relativeMs <= arr[0].t) return arr[0].v;
  if (relativeMs >= arr[arr.length - 1].t) return arr[arr.length - 1].v;
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i];
    const b = arr[i + 1];
    if (relativeMs >= a.t && relativeMs <= b.t) {
      if (a.easing === 'hold') return a.v;
      const span = Math.max(1, b.t - a.t);
      const p = (relativeMs - a.t) / span;
      const eased = easeFn(a.easing, p);
      return a.v + (b.v - a.v) * eased;
    }
  }
  return arr[arr.length - 1].v;
}

/** Return all keyframed property values at the given clip-relative time. */
export function valuesAt(tracks: KeyframeTracks, relativeMs: number): Partial<Record<KeyframeProperty, number>> {
  const out: Partial<Record<KeyframeProperty, number>> = {};
  for (const key of Object.keys(tracks) as KeyframeProperty[]) {
    const v = valueAt(tracks, key, relativeMs);
    if (v !== null) out[key] = v;
  }
  return out;
}

/**
 * Insert or update a keyframe at time `t` for the given property. Returns a NEW tracks object
 * (immutable). If a keyframe already exists within 1ms of `t`, its value is replaced.
 */
export function upsertKeyframe(
  tracks: KeyframeTracks,
  prop: KeyframeProperty,
  t: number,
  v: number,
  easing: KeyframeEasing = 'linear',
): KeyframeTracks {
  const existing = tracks[prop] ?? [];
  const idx = existing.findIndex((k) => Math.abs(k.t - t) < 1);
  let next: Keyframe[];
  if (idx >= 0) {
    next = existing.map((k, i) => (i === idx ? { ...k, v, easing } : k));
  } else {
    next = [...existing, { t, v, easing }].sort((a, b) => a.t - b.t);
  }
  return { ...tracks, [prop]: next };
}

/** Remove a single keyframe (by time) from the given track. */
export function removeKeyframeAt(tracks: KeyframeTracks, prop: KeyframeProperty, t: number): KeyframeTracks {
  const arr = tracks[prop];
  if (!arr) return tracks;
  const next = arr.filter((k) => Math.abs(k.t - t) >= 1);
  if (next.length === arr.length) return tracks;
  const out: KeyframeTracks = { ...tracks };
  if (next.length === 0) delete out[prop];
  else out[prop] = next;
  return out;
}

/** Remove all keyframes for a property. */
export function clearTrack(tracks: KeyframeTracks, prop: KeyframeProperty): KeyframeTracks {
  if (!tracks[prop]) return tracks;
  const out: KeyframeTracks = { ...tracks };
  delete out[prop];
  return out;
}
