import { useEffect, useRef, useState } from 'react';
import { FONT_CATALOG, FONT_CATEGORIES, ensureFontLoaded, preloadAllFonts } from '@/utils/fonts';
import { Icons } from '@/components/ui/icons';

export interface FontPickerProps {
  value: string;
  onChange: (font: string) => void;
}

export function FontPicker({ value, onChange }: FontPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [customInput, setCustomInput] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) preloadAllFonts();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = FONT_CATALOG.filter((f) =>
    !search.trim() || f.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ position: 'relative' }}>
      {/* Trigger button styled like other inspector inputs */}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          background: 'var(--bg-base)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 6,
          padding: '7px 10px',
          fontSize: 12,
          color: 'var(--text-primary)',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontFamily: value, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
        <Icons.Chev size={11} stroke="var(--accent-primary)" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            minWidth: 240,
            maxHeight: 420,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
            zIndex: 1500,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Search */}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: '4px 8px' }}>
              <Icons.Search size={10} stroke="var(--text-secondary)" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search fonts…"
                style={{ flex: 1, fontSize: 11, color: 'var(--text-primary)' }}
                autoFocus
              />
            </div>
          </div>

          {/* List, grouped by category. Each item renders the font name in its own typeface. */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {FONT_CATEGORIES.map((cat) => {
              const items = filtered.filter((f) => f.category === cat.id);
              if (items.length === 0) return null;
              return (
                <div key={cat.id}>
                  <div style={{ padding: '6px 10px 2px', fontSize: 9.5, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', background: 'var(--bg-elevated)', position: 'sticky', top: 0 }}>
                    {cat.label}
                  </div>
                  {items.map((f) => {
                    const active = f.name === value;
                    return (
                      <button
                        key={f.name}
                        onClick={() => { ensureFontLoaded(f); onChange(f.name); setOpen(false); }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          width: '100%',
                          padding: '8px 12px',
                          textAlign: 'left',
                          background: active ? 'rgba(200,242,58,0.10)' : 'transparent',
                          color: active ? 'var(--accent-primary)' : 'var(--text-primary)',
                          gap: 12,
                          transition: 'background .12s',
                        }}
                        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                      >
                        <span style={{ fontFamily: f.name, fontWeight: f.weight, fontSize: 18, minWidth: 120 }}>Ag</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12 }}>{f.name}</div>
                          {f.description && (
                            <div style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{f.description}</div>
                          )}
                        </div>
                        {active && <Icons.Check size={11} stroke="var(--accent-primary)" />}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div style={{ padding: 14, fontSize: 11, color: 'var(--text-muted)' }}>No fonts match.</div>
            )}
          </div>

          {/* Custom font input */}
          <div style={{ padding: '8px 10px', borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: 9.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 700, marginBottom: 4 }}>
              Custom font (must be installed locally)
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                placeholder="e.g. Comic Sans MS"
                style={{
                  flex: 1,
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 6,
                  padding: '5px 8px',
                  fontSize: 11,
                  color: 'var(--text-primary)',
                }}
              />
              <button
                onClick={() => {
                  if (!customInput.trim()) return;
                  onChange(customInput.trim());
                  setCustomInput('');
                  setOpen(false);
                }}
                className="sn-btn-primary"
                style={{ padding: '5px 10px', fontSize: 10 }}
              >
                Use
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
