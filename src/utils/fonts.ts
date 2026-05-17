export interface FontDef {
  name: string;           // CSS font-family value, e.g. "Bebas Neue"
  category: 'display' | 'sans' | 'serif' | 'mono' | 'handwriting';
  weight?: number;        // default 700 for display, 500 for sans, 400 for serif
  google?: boolean;       // whether to load from Google Fonts
  description?: string;   // optional tagline shown under name
}

export const FONT_CATALOG: FontDef[] = [
  // ---- System / already-loaded ----
  { name: 'Sora', category: 'sans', weight: 500, google: true },
  { name: 'Barlow Condensed', category: 'display', weight: 800, google: true, description: 'Condensed, viral-bold' },
  { name: 'JetBrains Mono', category: 'mono', weight: 500, google: true },
  // ---- Display / viral ----
  { name: 'Bebas Neue', category: 'display', weight: 400, google: true, description: 'Big bold caption staple' },
  { name: 'Anton', category: 'display', weight: 400, google: true, description: 'Heavy condensed' },
  { name: 'Oswald', category: 'display', weight: 700, google: true },
  { name: 'Russo One', category: 'display', weight: 400, google: true },
  { name: 'Bungee', category: 'display', weight: 400, google: true, description: 'Square block letters' },
  { name: 'Bowlby One', category: 'display', weight: 400, google: true },
  { name: 'Black Ops One', category: 'display', weight: 400, google: true, description: 'Stencil military' },
  { name: 'Audiowide', category: 'display', weight: 400, google: true, description: 'Retro-futurism' },
  { name: 'Monoton', category: 'display', weight: 400, google: true, description: 'Vintage striped' },
  // ---- Sans ----
  { name: 'Inter', category: 'sans', weight: 500, google: true },
  { name: 'Poppins', category: 'sans', weight: 600, google: true },
  { name: 'Montserrat', category: 'sans', weight: 600, google: true },
  { name: 'Raleway', category: 'sans', weight: 500, google: true },
  { name: 'Quicksand', category: 'sans', weight: 500, google: true, description: 'Rounded friendly' },
  { name: 'DM Sans', category: 'sans', weight: 500, google: true },
  { name: 'Outfit', category: 'sans', weight: 500, google: true },
  // ---- Serif ----
  { name: 'Playfair Display', category: 'serif', weight: 700, google: true, description: 'Editorial elegance' },
  { name: 'Merriweather', category: 'serif', weight: 700, google: true },
  { name: 'Lora', category: 'serif', weight: 500, google: true },
  { name: 'Cormorant Garamond', category: 'serif', weight: 600, google: true, description: 'Classic serif' },
  // ---- Mono ----
  { name: 'Fira Code', category: 'mono', weight: 500, google: true },
  { name: 'Source Code Pro', category: 'mono', weight: 500, google: true },
  { name: 'IBM Plex Mono', category: 'mono', weight: 500, google: true },
  // ---- Handwriting ----
  { name: 'Caveat', category: 'handwriting', weight: 600, google: true, description: 'Handwritten casual' },
  { name: 'Permanent Marker', category: 'handwriting', weight: 400, google: true },
  { name: 'Pacifico', category: 'handwriting', weight: 400, google: true },
  { name: 'Dancing Script', category: 'handwriting', weight: 600, google: true },
  { name: 'Shadows Into Light', category: 'handwriting', weight: 400, google: true },
];

export function findFont(name: string): FontDef | undefined {
  return FONT_CATALOG.find((f) => f.name.toLowerCase() === name.toLowerCase());
}

/**
 * Load a single Google Font on demand by injecting a `<link>` tag. No-op if already loaded.
 * Safe to call repeatedly; uses a Set to dedupe.
 */
const loadedFonts = new Set<string>();
export function ensureFontLoaded(font: FontDef): void {
  if (!font.google) return;
  if (loadedFonts.has(font.name)) return;
  const family = font.name.replace(/ /g, '+');
  const weight = font.weight ?? 500;
  const href = `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}&display=swap`;
  const existing = document.querySelector(`link[href="${href}"]`);
  if (!existing) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
  loadedFonts.add(font.name);
}

/** Load all fonts in the catalog at once. Used by FontPicker on mount. */
export function preloadAllFonts(): void {
  for (const f of FONT_CATALOG) ensureFontLoaded(f);
}

export const FONT_CATEGORIES: { id: FontDef['category']; label: string }[] = [
  { id: 'display', label: 'Display' },
  { id: 'sans', label: 'Sans-serif' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Monospace' },
  { id: 'handwriting', label: 'Handwriting' },
];
