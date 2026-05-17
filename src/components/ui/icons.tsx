// Stroke-based inline SVG icons ported from the design bundle.
import React from 'react';

interface IconProps {
  size?: number;
  stroke?: string;
  fill?: string;
  sw?: number;
  style?: React.CSSProperties;
  className?: string;
}

type IconComponent = (props: IconProps) => JSX.Element;

const make =
  (children: React.ReactNode, viewBox = '0 0 24 24'): IconComponent =>
  ({ size = 16, stroke = 'currentColor', fill = 'none', sw = 1.6, style, className }) => (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill={fill}
      stroke={stroke}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      className={className}
    >
      {children}
    </svg>
  );

const path = (d: string): React.ReactNode => <path d={d} />;

export const Mark: IconComponent = ({ size = 24, stroke = '#C8F23A' }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
    <path
      d="M22 7 C 22 7, 10 9, 10 14 C 10 19, 22 16, 22 21 C 22 25, 10 25, 10 25"
      stroke={stroke}
      strokeWidth={3}
      strokeLinecap="round"
    />
    <circle cx="10" cy="9" r="2.2" stroke={stroke} strokeWidth={2} fill="none" />
    <circle cx="22" cy="23" r="2.2" stroke={stroke} strokeWidth={2} fill="none" />
  </svg>
);

export const Icons = {
  Cursor: make(path('M5 3 L5 19 L9 15 L11.5 21 L13.5 20 L11 14 L17 14 Z')),
  Razor: make(
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M9 6 L20 17 M9 18 L20 7" />
    </>,
  ),
  TextT: make(path('M5 5 H19 M12 5 V19')),
  Star: make(path('M12 3 L14.6 9.2 L21 9.8 L16 14 L17.6 20.4 L12 17 L6.4 20.4 L8 14 L3 9.8 L9.4 9.2 Z')),
  Pen: make(path('M14 4 L20 10 L9 21 L3 21 L3 15 Z M13 5 L19 11')),
  Zoom: make(
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16 L21 21 M8 11 H14 M11 8 V14" />
    </>,
  ),
  Eye: make(
    <>
      <path d="M2 12 C 4 7, 8 5, 12 5 C 16 5, 20 7, 22 12 C 20 17, 16 19, 12 19 C 8 19, 4 17, 2 12 Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>,
  ),
  EyeOff: make(
    <path d="M3 3 L21 21 M6 6 C 4 8, 3 10, 2 12 C 4 17, 8 19, 12 19 C 14 19, 16 18.5, 18 17.5 M9.5 5.3 C 10.3 5.1, 11.1 5, 12 5 C 16 5, 20 7, 22 12 C 21.4 13.4, 20.6 14.6, 19.6 15.6" />,
  ),
  Lock: make(
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11 V8 A4 4 0 0 1 16 8 V11" />
    </>,
  ),
  Unlock: make(
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11 V8 A4 4 0 0 1 16 8" />
    </>,
  ),
  Play: ({ size = 16, fill = 'currentColor' }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
      <path d="M7 5 L19 12 L7 19 Z" />
    </svg>
  ),
  Pause: ({ size = 16, fill = 'currentColor' }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  ),
  SkipBack: ({ size = 16, fill = 'currentColor' }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
      <rect x="4" y="5" width="2" height="14" />
      <path d="M20 5 L8 12 L20 19 Z" />
    </svg>
  ),
  SkipFwd: ({ size = 16, fill = 'currentColor' }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
      <rect x="18" y="5" width="2" height="14" />
      <path d="M4 5 L16 12 L4 19 Z" />
    </svg>
  ),
  Back5: make(
    <>
      <path d="M4 7 A8 8 0 1 1 4 17" />
      <path d="M4 4 V8 H8" />
    </>,
  ),
  Fwd5: make(
    <>
      <path d="M20 7 A8 8 0 1 0 20 17" />
      <path d="M20 4 V8 H16" />
    </>,
  ),
  Volume: make(
    <>
      <path d="M4 9 H8 L13 5 V19 L8 15 H4 Z" />
      <path d="M16 9 A4 4 0 0 1 16 15" />
    </>,
  ),
  Mute: make(path('M4 9 H8 L13 5 V19 L8 15 H4 Z M17 9 L22 14 M22 9 L17 14')),
  Full: make(path('M4 9 V4 H9 M20 9 V4 H15 M4 15 V20 H9 M20 15 V20 H15')),
  Settings: make(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M5 5 L7 7 M17 17 L19 19 M5 19 L7 17 M17 7 L19 5" />
    </>,
  ),
  Plus: make(path('M12 5 V19 M5 12 H19')),
  PlusSm: ({ size = 16, stroke = 'currentColor' }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round">
      <path d="M12 5 V19 M5 12 H19" />
    </svg>
  ),
  X: make(path('M6 6 L18 18 M18 6 L6 18')),
  Chev: make(path('M6 9 L12 15 L18 9')),
  ChevRight: make(path('M9 6 L15 12 L9 18')),
  ChevLeft: make(path('M15 6 L9 12 L15 18')),
  Arrow: make(path('M5 12 H19 M13 6 L19 12 L13 18')),
  ArrowLeft: make(path('M19 12 H5 M11 6 L5 12 L11 18')),
  Undo: make(
    <>
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0 -4 -4 H4" />
    </>,
  ),
  Redo: make(
    <>
      <polyline points="15 14 20 9 15 4" />
      <path d="M4 20v-7a4 4 0 0 1 4 -4 h12" />
    </>,
  ),
  Home: make(path('M3 11 L12 3 L21 11 V21 H14 V14 H10 V21 H3 Z')),
  Folder: make(path('M3 7 A2 2 0 0 1 5 5 H10 L12 7 H19 A2 2 0 0 1 21 9 V18 A2 2 0 0 1 19 20 H5 A2 2 0 0 1 3 18 Z')),
  Stack: make(
    <>
      <path d="M3 7 L12 3 L21 7 L12 11 Z" />
      <path d="M3 12 L12 16 L21 12 M3 17 L12 21 L21 17" />
    </>,
  ),
  Upload: make(path('M12 16 V4 M6 10 L12 4 L18 10 M4 18 H20 V21 H4 Z')),
  Download: make(path('M12 4 V16 M6 12 L12 18 L18 12 M4 21 H20')),
  Trash: make(path('M5 7 H19 M9 7 V4 H15 V7 M7 7 L8 21 H16 L17 7 M10 11 V18 M14 11 V18')),
  Search: make(
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16 L21 21" />
    </>,
  ),
  Layers: make(
    <>
      <path d="M3 7 L12 3 L21 7 L12 11 Z" />
      <path d="M3 12 L12 16 L21 12 M3 17 L12 21 L21 17" />
    </>,
  ),
  Wand: make(path('M4 20 L16 8 M14 6 L18 10 M19 4 V8 M17 6 H21 M6 4 V8 M4 6 H8')),
  Spark: make(path('M12 3 L13.5 10.5 L21 12 L13.5 13.5 L12 21 L10.5 13.5 L3 12 L10.5 10.5 Z')),
  Music: make(
    <>
      <path d="M9 18 V6 L20 4 V16" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="18" cy="16" r="2" />
    </>,
  ),
  Image: make(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M5 17 L10 13 L15 17 L20 13" />
    </>,
  ),
  Mic: make(
    <>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11 A7 7 0 0 0 19 11 M12 18 V22 M8 22 H16" />
    </>,
  ),
  Sun: make(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M5 5 L7 7 M17 17 L19 19 M5 19 L7 17 M17 7 L19 5" />
    </>,
  ),
  Moon: make(path('M20 14 A8 8 0 1 1 10 4 A6 6 0 0 0 20 14 Z')),
  Clock: make(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7 V12 L15 14" />
    </>,
  ),
  Drop: make(path('M12 3 L18 12 A6 6 0 1 1 6 12 Z')),
  Sliders: make(
    <>
      <path d="M4 6 H20 M4 12 H20 M4 18 H20" />
      <circle cx="9" cy="6" r="2" fill="#0A0A0C" />
      <circle cx="15" cy="12" r="2" fill="#0A0A0C" />
      <circle cx="7" cy="18" r="2" fill="#0A0A0C" />
    </>,
  ),
  Filter: make(path('M3 5 H21 L14 13 V20 L10 18 V13 Z')),
  Cube: make(
    <>
      <path d="M12 3 L21 8 V16 L12 21 L3 16 V8 Z" />
      <path d="M3 8 L12 13 L21 8 M12 13 V21" />
    </>,
  ),
  Sparkle: make(
    <>
      <path d="M12 3 L13 9 L19 10 L13 11 L12 17 L11 11 L5 10 L11 9 Z" />
      <path d="M19 16 L19.6 18.4 L22 19 L19.6 19.6 L19 22 L18.4 19.6 L16 19 L18.4 18.4 Z" />
    </>,
  ),
  Grid: make(
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>,
  ),
  Solo: make(
    <>
      <circle cx="12" cy="12" r="3" fill="currentColor" />
      <path d="M5 12 A7 7 0 0 1 19 12" />
    </>,
  ),
  Headphones: make(
    <>
      <path d="M3 14 V12 A9 9 0 0 1 21 12 V14" />
      <rect x="3" y="14" width="5" height="7" rx="1.5" />
      <rect x="16" y="14" width="5" height="7" rx="1.5" />
    </>,
  ),
  Check: make(path('M5 12 L10 17 L20 7')),
  Phone: make(
    <>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 19 H13" />
    </>,
  ),
  Monitor: make(
    <>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M9 21 H15 M12 17 V21" />
    </>,
  ),
  Square: make(<rect x="4" y="4" width="16" height="16" rx="2" />),
  Caption: make(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M6 14 H10 M12 14 H16 M6 11 H14" />
    </>,
  ),
  Link: make(path('M10 14 A4 4 0 0 0 14 14 L17 11 A4 4 0 0 0 11 5 L10 6 M14 10 A4 4 0 0 0 10 10 L7 13 A4 4 0 0 0 13 19 L14 18')),
  FlipH: make(path('M12 3 V21 M5 8 L9 12 L5 16 V8 M19 8 L15 12 L19 16 V8')),
  Rotate: make(
    <>
      <path d="M4 12 A8 8 0 1 1 12 20" />
      <path d="M4 9 V13 H8" />
    </>,
  ),
  Hand: make(
    <>
      <path d="M8 13 V6 A1.5 1.5 0 0 1 11 6 V11" />
      <path d="M11 11 V4.5 A1.5 1.5 0 0 1 14 4.5 V11" />
      <path d="M14 11 V5.5 A1.5 1.5 0 0 1 17 5.5 V13" />
      <path d="M17 9 A1.5 1.5 0 0 1 20 9 V15 A6 6 0 0 1 14 21 H12 A6 6 0 0 1 6 15 V12 A1.5 1.5 0 0 1 9 12" />
    </>,
  ),
};
