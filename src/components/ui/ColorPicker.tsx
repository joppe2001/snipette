import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  hexToRgb,
  hsvToRgb,
  normalizeHex,
  rgbToHex,
  rgbToHsv,
  type HSV,
  type RGB,
} from '@/utils/color-conversions';
import { Icons } from '@/components/ui/icons';

export interface ColorPickerProps {
  /** Current hex color, e.g. "#C8F23A". */
  color: string;
  /** Fires whenever the user changes the color via swatch/SV/hue/inputs/eyedropper/recent. */
  onChange: (hex: string) => void;
  /** Optional small label rendered next to the swatch (currently unused visually, kept for parity). */
  label?: string;
  /** Optional shared recent-colors list (caller-managed). */
  recent?: string[];
  /** Called when the user clicks one of the recent swatches. */
  onPickRecent?: (hex: string) => void;
}

// Coordinates of the SV thumb expressed as a {x, y} ratio in [0,1]. Y is inverted
// from V so the bright corner is in the top-right (standard color-picker layout).
interface Ratio { x: number; y: number }

function svFromRatio(ratio: Ratio): { s: number; v: number } {
  return {
    s: Math.max(0, Math.min(1, ratio.x)),
    v: Math.max(0, Math.min(1, 1 - ratio.y)),
  };
}

function ratioFromSV(s: number, v: number): Ratio {
  return { x: s, y: 1 - v };
}

const POPOVER_WIDTH = 220;
const SV_WIDTH = POPOVER_WIDTH - 24; // 12 px padding on each side
const SV_HEIGHT = 140;
const HUE_HEIGHT = 12;

export function ColorPicker({
  color,
  onChange,
  recent,
  onPickRecent,
}: ColorPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  // Single source of truth while the picker is open. We keep HSV around because two
  // different hex values can map to the same hue when s or v is 0 — switching from
  // hue/sv input to RGB input would otherwise reset the hue strip.
  const [hsv, setHsv] = useState<HSV>(() => {
    const rgb = hexToRgb(color) ?? { r: 0, g: 0, b: 0 };
    return rgbToHsv(rgb);
  });
  const [hexDraft, setHexDraft] = useState<string>(() => normalizeHex(color) ?? '#000000');
  const [rgbDraft, setRgbDraft] = useState<RGB>(() => hexToRgb(color) ?? { r: 0, g: 0, b: 0 });

  // Sync internal state when the prop changes from the outside (e.g. template applied).
  useEffect(() => {
    const rgb = hexToRgb(color);
    if (!rgb) return;
    setHsv((prev) => {
      const next = rgbToHsv(rgb);
      // Preserve hue when the new color is achromatic so the strip thumb stays put.
      if (next.s === 0) return { ...next, h: prev.h };
      return next;
    });
    setRgbDraft(rgb);
    setHexDraft(rgbToHex(rgb));
  }, [color]);

  // ---- Commit helpers ---------------------------------------------------------

  const commitHsv = useCallback(
    (next: HSV) => {
      setHsv(next);
      const rgb = hsvToRgb(next);
      const hex = rgbToHex(rgb);
      setRgbDraft(rgb);
      setHexDraft(hex);
      onChange(hex);
    },
    [onChange],
  );

  const commitRgb = useCallback(
    (next: RGB) => {
      const hex = rgbToHex(next);
      setRgbDraft(next);
      setHexDraft(hex);
      setHsv((prev) => {
        const nextHsv = rgbToHsv(next);
        if (nextHsv.s === 0) return { ...nextHsv, h: prev.h };
        return nextHsv;
      });
      onChange(hex);
    },
    [onChange],
  );

  const commitHex = useCallback(
    (raw: string) => {
      const normalized = normalizeHex(raw);
      if (!normalized) return;
      const rgb = hexToRgb(normalized);
      if (!rgb) return;
      setHexDraft(normalized);
      setRgbDraft(rgb);
      setHsv((prev) => {
        const next = rgbToHsv(rgb);
        if (next.s === 0) return { ...next, h: prev.h };
        return next;
      });
      onChange(normalized);
    },
    [onChange],
  );

  // ---- Outside-click + Esc dismissal -----------------------------------------

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // ---- SV square pointer handling --------------------------------------------

  const updateSvFromEvent = useCallback(
    (event: PointerEvent | React.PointerEvent) => {
      const el = svRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      const { s, v } = svFromRatio({ x, y });
      commitHsv({ h: hsv.h, s, v });
    },
    [commitHsv, hsv.h],
  );

  const onSvPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const el = svRef.current;
    if (!el) return;
    el.setPointerCapture(event.pointerId);
    updateSvFromEvent(event);
  };

  const onSvPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.buttons === 0) return; // only drag while a button is held
    updateSvFromEvent(event);
  };

  const onSvPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = svRef.current;
    if (el?.hasPointerCapture(event.pointerId)) {
      el.releasePointerCapture(event.pointerId);
    }
  };

  // ---- Hue strip pointer handling --------------------------------------------

  const updateHueFromEvent = useCallback(
    (event: PointerEvent | React.PointerEvent) => {
      const el = hueRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      commitHsv({ ...hsv, h: x * 360 });
    },
    [commitHsv, hsv],
  );

  const onHuePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const el = hueRef.current;
    if (!el) return;
    el.setPointerCapture(event.pointerId);
    updateHueFromEvent(event);
  };

  const onHuePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.buttons === 0) return;
    updateHueFromEvent(event);
  };

  const onHuePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = hueRef.current;
    if (el?.hasPointerCapture(event.pointerId)) {
      el.releasePointerCapture(event.pointerId);
    }
  };

  // ---- Eyedropper ------------------------------------------------------------

  const eyedrop = async () => {
    try {
      // @ts-expect-error EyeDropper is not in lib.dom yet (Chromium 95+).
      const dropper = new EyeDropper();
      const result = (await dropper.open()) as { sRGBHex?: string } | undefined;
      if (result?.sRGBHex) {
        const hex = normalizeHex(result.sRGBHex);
        if (hex) commitHex(hex);
      }
    } catch {
      // User canceled or EyeDropper unavailable — silently ignore.
    }
  };

  const eyedropperAvailable = typeof window !== 'undefined' && 'EyeDropper' in window;

  // ---- Derived display values ------------------------------------------------

  const svThumb = useMemo(() => ratioFromSV(hsv.s, hsv.v), [hsv.s, hsv.v]);
  const hueCss = useMemo(() => `hsl(${Math.round(hsv.h)}, 100%, 50%)`, [hsv.h]);
  const currentHex = useMemo(() => rgbToHex(rgbDraft), [rgbDraft]);

  // ---- Render ----------------------------------------------------------------

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block', width: '100%' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'var(--bg-base)',
          borderRadius: 6,
          border: `1px solid ${open ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
          padding: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          width: '100%',
        }}
      >
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            background: currentHex,
            border: '1px solid var(--border-subtle)',
            flex: '0 0 auto',
          }}
        />
        <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
          {currentHex}
        </span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Color picker"
          style={{
            position: 'absolute',
            left: 0,
            top: 'calc(100% + 8px)',
            width: POPOVER_WIDTH,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: 12,
            boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
            zIndex: 1500,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {/* Top row: current color preview + eyedropper + close */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: 4,
                background: currentHex,
                border: '1px solid var(--border-subtle)',
                flex: '0 0 auto',
              }}
            />
            <span
              className="mono"
              style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1, overflow: 'hidden' }}
            >
              {currentHex}
            </span>
            {eyedropperAvailable && (
              <button
                type="button"
                onClick={eyedrop}
                title="Pick a color from the screen"
                style={{
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 4,
                  padding: 4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                }}
              >
                <Icons.Drop size={12} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              title="Close"
              style={{
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 4,
                padding: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
              }}
            >
              <Icons.X size={12} />
            </button>
          </div>

          {/* SV square */}
          <div
            ref={svRef}
            onPointerDown={onSvPointerDown}
            onPointerMove={onSvPointerMove}
            onPointerUp={onSvPointerUp}
            onPointerCancel={onSvPointerUp}
            style={{
              position: 'relative',
              width: SV_WIDTH,
              height: SV_HEIGHT,
              borderRadius: 6,
              cursor: 'crosshair',
              userSelect: 'none',
              touchAction: 'none',
              background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueCss})`,
              border: '1px solid var(--border-subtle)',
              overflow: 'hidden',
            }}
          >
            <span
              aria-hidden
              style={{
                position: 'absolute',
                left: `${svThumb.x * 100}%`,
                top: `${svThumb.y * 100}%`,
                transform: 'translate(-50%, -50%)',
                width: 12,
                height: 12,
                borderRadius: '50%',
                border: '1.5px solid var(--accent-primary)',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
                background: 'transparent',
                pointerEvents: 'none',
              }}
            />
          </div>

          {/* Hue strip */}
          <div
            ref={hueRef}
            onPointerDown={onHuePointerDown}
            onPointerMove={onHuePointerMove}
            onPointerUp={onHuePointerUp}
            onPointerCancel={onHuePointerUp}
            style={{
              position: 'relative',
              width: SV_WIDTH,
              height: HUE_HEIGHT,
              borderRadius: 4,
              cursor: 'ew-resize',
              userSelect: 'none',
              touchAction: 'none',
              background:
                'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
              border: '1px solid var(--border-subtle)',
              overflow: 'hidden',
            }}
          >
            <span
              aria-hidden
              style={{
                position: 'absolute',
                left: `${(hsv.h / 360) * 100}%`,
                top: 0,
                bottom: 0,
                width: 3,
                transform: 'translateX(-50%)',
                background: 'var(--accent-primary)',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
                pointerEvents: 'none',
              }}
            />
          </div>

          {/* Hex input */}
          <input
            type="text"
            value={hexDraft}
            onChange={(e) => {
              setHexDraft(e.target.value);
              const normalized = normalizeHex(e.target.value);
              if (normalized) commitHex(normalized);
            }}
            onBlur={() => {
              const normalized = normalizeHex(hexDraft);
              if (normalized) {
                setHexDraft(normalized);
              } else {
                // Reset to current valid hex on invalid blur.
                setHexDraft(rgbToHex(rgbDraft));
              }
            }}
            className="mono"
            spellCheck={false}
            style={{
              background: 'var(--bg-base)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              color: 'var(--text-primary)',
              fontSize: 12,
              padding: '6px 8px',
              width: '100%',
              outline: 'none',
              textTransform: 'uppercase',
            }}
          />

          {/* RGB inputs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            <ChannelInput
              label="R"
              value={rgbDraft.r}
              onCommit={(v) => commitRgb({ ...rgbDraft, r: v })}
            />
            <ChannelInput
              label="G"
              value={rgbDraft.g}
              onCommit={(v) => commitRgb({ ...rgbDraft, g: v })}
            />
            <ChannelInput
              label="B"
              value={rgbDraft.b}
              onCommit={(v) => commitRgb({ ...rgbDraft, b: v })}
            />
          </div>

          {/* Recent colors */}
          {recent && recent.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span
                style={{
                  fontSize: 9,
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                  fontWeight: 600,
                }}
              >
                Recent
              </span>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {recent.slice(0, 6).map((hex, idx) => {
                  const normalized = normalizeHex(hex) ?? '#000000';
                  return (
                    <button
                      key={`${normalized}-${idx}`}
                      type="button"
                      onClick={() => {
                        commitHex(normalized);
                        onPickRecent?.(normalized);
                        setOpen(false);
                      }}
                      title={normalized}
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 4,
                        background: normalized,
                        border: '1px solid var(--border-subtle)',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A small uniform numeric input for one of the R/G/B channels. We keep a local
 * string draft so users can type freely and only commit on blur / Enter.
 */
function ChannelInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<string>(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const flush = () => {
    const parsed = parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.max(0, Math.min(255, parsed));
    if (clamped !== value) onCommit(clamped);
    setDraft(String(clamped));
  };

  return (
    <div
      style={{
        background: 'var(--bg-base)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 6,
        padding: '4px 6px',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 600 }}>{label}</span>
      <input
        type="number"
        min={0}
        max={255}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={flush}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          }
        }}
        className="mono"
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          color: 'var(--text-primary)',
          fontSize: 11,
          outline: 'none',
          padding: 0,
          minWidth: 0,
        }}
      />
    </div>
  );
}
