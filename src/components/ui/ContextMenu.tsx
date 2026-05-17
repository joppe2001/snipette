import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEditorStore } from '@/store/editor.store';

export function ContextMenu(): JSX.Element | null {
  const menu = useEditorStore((s) => s.contextMenu);
  const setMenu = useEditorStore((s) => s.setContextMenu);
  const ref = useRef<HTMLDivElement>(null);
  // Position is recomputed AFTER the menu measures so a tall menu opening near the
  // bottom flips upward and a wide one near the right flips leftward. Without this
  // the menu just clips off-screen.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    // Hoisted to a named const so it can be removed in cleanup — previously this
    // listener leaked one fresh closure per menu open, accumulating indefinitely.
    const onContextMenu = (e: MouseEvent) => {
      // Allow a fresh right-click to dismiss the current menu and let the new one open.
      if (!(e.target as HTMLElement | null)?.closest?.('[data-sn-context-menu]')) close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('contextmenu', onContextMenu);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('contextmenu', onContextMenu);
    };
  }, [menu, setMenu]);

  // Reset position when a new menu opens so the layout effect re-measures it.
  useEffect(() => {
    setPos(null);
  }, [menu?.x, menu?.y, menu?.items]);

  // Measure-then-clamp. Runs synchronously after paint so the user never sees the
  // un-clamped frame.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const margin = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = menu.x;
    let top = menu.y;
    if (left + rect.width + margin > vw) left = Math.max(margin, vw - rect.width - margin);
    if (top + rect.height + margin > vh) top = Math.max(margin, vh - rect.height - margin);
    if (left !== (pos?.left ?? -1) || top !== (pos?.top ?? -1)) setPos({ left, top });
  }, [menu, pos]);

  if (!menu) return null;
  return (
    <div
      ref={ref}
      data-sn-context-menu
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        // Render off-screen until measurement clamps to viewport — avoids a one-frame
        // pop where the menu shows in the overflowed spot before flipping.
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        padding: 4,
        minWidth: 220,
        maxWidth: 320,
        maxHeight: 'calc(100vh - 12px)',
        overflowY: 'auto',
        boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
        zIndex: 1500,
        userSelect: 'none',
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {menu.items.map((item, i) => {
        if (item.kind === 'separator') {
          return <div key={i} className="sn-divider" style={{ margin: '4px 0' }} />;
        }
        if (item.kind === 'header') {
          return (
            <div
              key={i}
              className="sn-section-label"
              style={{ padding: '6px 10px 2px', color: 'var(--text-muted)' }}
            >
              {item.label}
            </div>
          );
        }
        const it = item;
        return (
          <button
            key={i}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onClick();
              setMenu(null);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              width: '100%',
              textAlign: 'left',
              padding: '7px 10px',
              fontSize: 12,
              borderRadius: 4,
              color: it.disabled
                ? 'var(--text-muted)'
                : it.danger
                  ? 'var(--red-alert)'
                  : 'var(--text-primary)',
              background: 'transparent',
              cursor: it.disabled ? 'not-allowed' : 'pointer',
            }}
            onMouseEnter={(e) => {
              if (!it.disabled) e.currentTarget.style.background = 'var(--bg-hover)';
            }}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span>{it.label}</span>
            {it.hint && (
              <span className="mono" style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>
                {it.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
