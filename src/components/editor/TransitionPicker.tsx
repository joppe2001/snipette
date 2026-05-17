import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '@/store/editor.store';
import { useTimelineStore } from '@/store/timeline.store';
import { Slider } from '@/components/ui/Slider';
import { TRANSITION_CATALOG } from '@/utils/transition-catalog';

const POPOVER_W = 320;
const POPOVER_H = 440;

/**
 * Floating transition picker. Opened by the "+" between two adjacent clips. Shows the full
 * catalog of transitions as live preview cards, plus a duration slider. Clicking a card
 * commits the transition with the chosen duration and closes the popover.
 */
export function TransitionPicker(): JSX.Element | null {
  const picker = useEditorStore((s) => s.transitionPicker);
  const close = useEditorStore((s) => s.closeTransitionPicker);
  const pushToast = useEditorStore((s) => s.pushToast);
  const addTransitionLocal = useTimelineStore((s) => s.addTransitionLocal);
  const pushHistory = useTimelineStore((s) => s.pushHistory);

  const ref = useRef<HTMLDivElement>(null);
  const [durationMs, setDurationMs] = useState(500);

  // Reset duration to default each time the picker opens for a different pair.
  useEffect(() => {
    if (picker) setDurationMs(500);
  }, [picker?.clipAId, picker?.clipBId]);

  useEffect(() => {
    if (!picker) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [picker, close]);

  if (!picker) return null;

  const apply = async (type: string) => {
    pushHistory();
    try {
      const created = await window.snipette.timeline.addTransition({
        project_id: picker.projectId,
        track_id: picker.trackId,
        clip_a_id: picker.clipAId,
        clip_b_id: picker.clipBId,
        type,
        duration_ms: durationMs,
      });
      addTransitionLocal(created);
      pushToast({ kind: 'success', message: `${type} transition added` });
    } catch (e) {
      pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Failed to add transition.' });
    }
    close();
  };

  // Clamp position to keep the popover on-screen.
  const left = Math.min(Math.max(8, picker.x), window.innerWidth - POPOVER_W - 8);
  const top = Math.min(Math.max(8, picker.y), window.innerHeight - POPOVER_H - 8);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left,
        top,
        width: POPOVER_W,
        maxHeight: POPOVER_H,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 10,
        boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
        zIndex: 1500,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      <div style={{ padding: '10px 12px 6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="sn-section-label">Add transition</span>
        <span className="mono" style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>esc</span>
      </div>

      <div style={{ padding: '6px 12px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 10.5, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>
            Duration
          </span>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--accent-primary)' }}>
            {durationMs} ms
          </span>
        </div>
        <Slider value={durationMs} min={100} max={2000} onChange={(v) => setDurationMs(Math.round(v))} />
      </div>

      <div style={{ overflow: 'auto', padding: '0 10px 10px', flex: 1 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
          {TRANSITION_CATALOG.map((tr) => (
            <button
              key={tr.type}
              onClick={() => apply(tr.type)}
              title={tr.description}
              style={{ background: 'transparent', padding: 0, textAlign: 'left' }}
            >
              <div
                style={{
                  aspectRatio: '4/3',
                  borderRadius: 6,
                  background: '#0a0a10',
                  position: 'relative',
                  overflow: 'hidden',
                  border: '1px solid var(--border-subtle)',
                  transition: 'border-color .12s, transform .12s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent-primary)';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-subtle)';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                <div
                  className={`sn-trans-${tr.type}-a`}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'linear-gradient(135deg, #f23ac8, #f2a83a)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#0a0a0c',
                    fontFamily: 'var(--font-display)',
                    fontSize: 24,
                    fontWeight: 800,
                  }}
                >
                  A
                </div>
                <div
                  className={`sn-trans-${tr.type}-b`}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'linear-gradient(135deg, #3ac8f2, #c8f23a)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#0a0a0c',
                    fontFamily: 'var(--font-display)',
                    fontSize: 24,
                    fontWeight: 800,
                  }}
                >
                  B
                </div>
              </div>
              <div style={{ fontSize: 10.5, fontWeight: 600, marginTop: 4, color: 'var(--text-primary)' }}>{tr.name}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
