import React, { useCallback, useRef } from 'react';
import { useEditorStore } from '@/store/editor.store';

interface Props {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  className?: string;
  defaultValue?: number;
  onReset?: () => void;
  propertyName?: string;
}

export function Slider({
  value,
  min = 0,
  max = 1,
  step,
  onChange,
  onCommit,
  className = '',
  defaultValue,
  onReset,
  propertyName,
}: Props): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const setContextMenu = useEditorStore((s) => s.setContextMenu);

  const pct = ((value - min) / (max - min)) * 100;

  const compute = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return value;
      const rect = el.getBoundingClientRect();
      let p = (clientX - rect.left) / rect.width;
      p = Math.max(0, Math.min(1, p));
      let next = min + p * (max - min);
      if (step) next = Math.round(next / step) * step;
      return next;
    },
    [value, min, max, step],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    onChange(compute(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.buttons === 0) return;
    onChange(compute(e.clientX));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture(e.pointerId);
    onCommit?.(compute(e.clientX));
  };

  const doReset = () => {
    if (onReset) {
      onReset();
      return;
    }
    if (defaultValue !== undefined) {
      onChange(defaultValue);
      onCommit?.(defaultValue);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (defaultValue === undefined && !onReset) return;
    e.preventDefault();
    e.stopPropagation();
    doReset();
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const label = propertyName ?? 'Value';
    const formatted = step && step >= 1 ? String(Math.round(value)) : String(Number(value.toFixed(3)));
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { kind: 'header', label },
        {
          label: 'Reset to default',
          disabled: defaultValue === undefined && !onReset,
          onClick: doReset,
        },
        {
          label: 'Copy value',
          onClick: () => {
            void navigator.clipboard.writeText(formatted);
          },
        },
        {
          label: 'Type exact value…',
          onClick: () => {
            const input = window.prompt(`${label} (${min} – ${max})`, formatted);
            if (input == null) return;
            const parsed = Number(input);
            if (!Number.isFinite(parsed)) return;
            const clamped = Math.max(min, Math.min(max, parsed));
            onChange(clamped);
            onCommit?.(clamped);
          },
        },
      ],
    });
  };

  return (
    <div
      ref={trackRef}
      className={`sn-slider-track ${className}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className="sn-slider-fill" style={{ width: `${pct}%` }} />
      <div className="sn-slider-thumb" style={{ left: `${pct}%` }} />
    </div>
  );
}
