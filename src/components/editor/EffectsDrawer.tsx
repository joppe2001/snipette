import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { Icons } from '@/components/ui/icons';
import { useEditorStore } from '@/store/editor.store';
import { useTimelineStore } from '@/store/timeline.store';
import { useProjectStore } from '@/store/project.store';
import { MOTION_FX_LIBRARY, parseEffects, serializeEffects, type MotionFxType } from '@/utils/motion-fx';
import { parseEffectsArray, type RawEffectEntry } from '@/utils/audio-fx';
import { TRANSITION_CATALOG } from '@/utils/transition-catalog';

const TABS = ['Transitions', 'Filters', 'LUTs', 'Motion FX', 'AI'] as const;
type Tab = (typeof TABS)[number];

const TRANSITIONS = TRANSITION_CATALOG;

const FILTERS: { name: string; cssFilter: string; grade: Record<string, number> }[] = [
  { name: 'None', cssFilter: '', grade: {} },
  { name: 'Cinematic', cssFilter: 'contrast(1.12) saturate(0.94) hue-rotate(6deg) brightness(0.96)', grade: { contrast: 12, saturation: -6, temperature: 8, shadows: -8 } },
  { name: 'Vintage', cssFilter: 'contrast(0.94) saturate(1.08) sepia(0.2) hue-rotate(12deg)', grade: { contrast: -6, saturation: 8, temperature: 24 } },
  { name: 'Pastel', cssFilter: 'contrast(0.88) saturate(0.8) brightness(1.08)', grade: { contrast: -12, saturation: -20, temperature: -10 } },
  { name: 'B&W', cssFilter: 'grayscale(1) contrast(1.18)', grade: { saturation: -100, contrast: 18 } },
  { name: 'Vivid', cssFilter: 'contrast(1.14) saturate(1.4)', grade: { saturation: 30, contrast: 14 } },
  { name: 'Berlin', cssFilter: 'contrast(1.1) saturate(0.95) hue-rotate(-22deg)', grade: { temperature: -28, contrast: 10, shadows: -8 } },
  { name: 'Mood', cssFilter: 'contrast(1.18) brightness(0.85) saturate(0.85)', grade: { temperature: -8, contrast: 18, shadows: -20 } },
  { name: 'Warm', cssFilter: 'hue-rotate(18deg) saturate(1.1) brightness(1.02)', grade: { temperature: 24, saturation: 8 } },
  { name: 'Crush', cssFilter: 'contrast(1.4) saturate(0.7) brightness(0.9)', grade: { contrast: 40, saturation: -30, shadows: -10 } },
  { name: 'Sunset', cssFilter: 'sepia(0.3) hue-rotate(-12deg) saturate(1.25)', grade: { temperature: 32, saturation: 16 } },
  { name: 'Cyber', cssFilter: 'contrast(1.2) saturate(1.2) hue-rotate(180deg)', grade: { temperature: -32, saturation: 18, contrast: 18 } },
];

export function EffectsDrawer(): JSX.Element {
  const open = useEditorStore((s) => s.effectsDrawerOpen);
  const close = useEditorStore((s) => s.closeEffectsDrawer);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const replaceClip = useTimelineStore((s) => s.replaceClip);
  const clips = useTimelineStore((s) => s.clips);
  const transitions = useTimelineStore((s) => s.transitions);
  const addTransitionLocal = useTimelineStore((s) => s.addTransitionLocal);
  const project = useProjectStore((s) => s.activeProject);
  const pushToast = useEditorStore((s) => s.pushToast);
  const [tab, setTab] = useState<Tab>('Transitions');
  const [search, setSearch] = useState('');

  /**
   * Apply a transition between two clips:
   *  - If user has 2 clips selected on the same track that are adjacent → bridge them.
   *  - Else, pick the selected clip + the next clip on its track.
   *  - Else, warn via toast.
   */
  const applyTransition = async (type: string, label: string) => {
    if (!project) return;
    let clipA: typeof clips[number] | undefined;
    let clipB: typeof clips[number] | undefined;
    if (selectedClipIds.length === 2) {
      const sel = clips.filter((c) => selectedClipIds.includes(c.id));
      sel.sort((a, b) => a.start_time_ms - b.start_time_ms);
      if (sel[0].track_id === sel[1].track_id) {
        clipA = sel[0];
        clipB = sel[1];
      }
    } else if (selectedClipIds.length === 1) {
      const a = clips.find((c) => c.id === selectedClipIds[0]);
      if (a) {
        const onSameTrack = clips.filter((c) => c.track_id === a.track_id && c.start_time_ms > a.start_time_ms);
        onSameTrack.sort((x, y) => x.start_time_ms - y.start_time_ms);
        clipA = a;
        clipB = onSameTrack[0];
      }
    }
    if (!clipA || !clipB) {
      pushToast({
        kind: 'info',
        message: 'Select two adjacent clips on the same track (or one clip with a clip after it) to add a transition.',
      });
      return;
    }
    const existing = transitions.find(
      (t) => (t.clip_a_id === clipA.id && t.clip_b_id === clipB.id) || (t.clip_b_id === clipA.id && t.clip_a_id === clipB.id),
    );
    if (existing) {
      pushToast({ kind: 'info', message: 'Those clips already have a transition. Remove it first.' });
      return;
    }
    useTimelineStore.getState().pushHistory();
    const created = await window.snipette.timeline.addTransition({
      project_id: project.id,
      track_id: clipA.track_id,
      clip_a_id: clipA.id,
      clip_b_id: clipB.id,
      type,
      duration_ms: 500,
    });
    addTransitionLocal(created);
    pushToast({ kind: 'success', message: `${label} transition added` });
  };

  const applyFilter = async (name: string) => {
    if (selectedClipIds.length === 0) {
      pushToast({ kind: 'info', message: 'Select a clip first.' });
      return;
    }
    const grade = FILTERS.find((f) => f.name === name)?.grade ?? {};
    const isNone = name === 'None' || Object.keys(grade).length === 0;
    useTimelineStore.getState().pushHistory();
    const clips = useTimelineStore.getState().clips;
    for (const id of selectedClipIds) {
      const target = clips.find((c) => c.id === id);
      // Refresh the `filter-preset` sidecar entry on effects_json so the timeline's
      // clip badge can show the actual preset name (e.g. "Cinematic") rather than
      // a generic "CG". The entry has no runtime effect — it's UI metadata.
      const otherEntries: RawEffectEntry[] = parseEffectsArray(target?.effects_json).filter(
        (e) => e.type !== 'filter-preset',
      );
      const nextEntries: RawEffectEntry[] = isNone
        ? otherEntries
        : [...otherEntries, { type: 'filter-preset', name }];
      const updated = await window.snipette.timeline.updateClip(id, {
        color_grade_json: Object.keys(grade).length === 0 ? null : JSON.stringify(grade),
        effects_json: JSON.stringify(nextEntries),
      });
      replaceClip(updated);
    }
    pushToast({ kind: 'success', message: `${name} applied` });
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ x: 420 }}
          animate={{ x: 0 }}
          exit={{ x: 420 }}
          transition={{ type: 'spring', damping: 26, stiffness: 280 }}
          style={{
            position: 'absolute',
            top: 52,
            bottom: 0,
            right: 0,
            width: 420,
            background: 'var(--bg-surface)',
            borderLeft: '1px solid var(--border-subtle)',
            boxShadow: '-12px 0 32px rgba(0,0,0,0.4)',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 60,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
            <span className="display" style={{ fontSize: 18, letterSpacing: '0.06em' }}>Effects</span>
            <div style={{ flex: 1 }} />
            <button className="sn-icon-btn" onClick={close} aria-label="Close"><Icons.X size={14} /></button>
          </div>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border-subtle)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 999,
                padding: '6px 12px',
              }}
            >
              <Icons.Search size={11} stroke="var(--text-secondary)" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search effects…"
                style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 10 }}>
              {TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  style={{
                    padding: '4px 10px',
                    fontSize: 11,
                    fontWeight: 600,
                    background: tab === t ? 'rgba(200,242,58,0.1)' : 'transparent',
                    color: tab === t ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    borderRadius: 6,
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div style={{ overflow: 'auto', padding: 16, flex: 1 }}>
            {tab === 'Transitions' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                {TRANSITIONS.filter((tr) => tr.name.toLowerCase().includes(search.toLowerCase())).map((tr) => (
                  <TransitionPreviewCard
                    key={tr.name}
                    type={tr.type}
                    name={tr.name}
                    description={tr.description}
                    onApply={() => applyTransition(tr.type, tr.name)}
                  />
                ))}
              </div>
            )}
            {tab === 'Filters' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                {FILTERS.filter((f) => f.name.toLowerCase().includes(search.toLowerCase())).map((f) => (
                  <FilterPreviewCard
                    key={f.name}
                    name={f.name}
                    cssFilter={f.cssFilter}
                    onApply={() => applyFilter(f.name)}
                  />
                ))}
              </div>
            )}
            {tab === 'LUTs' && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Drop .cube LUT files into resources/luts to see them here. Snipette ships with no third-party LUTs.
              </div>
            )}
            {tab === 'Motion FX' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                {MOTION_FX_LIBRARY.filter((fx) => fx.name.toLowerCase().includes(search.toLowerCase())).map((fx) => (
                  <MotionFxCard key={fx.type} type={fx.type} name={fx.name} description={fx.description} defaultIntensity={fx.defaultIntensity} />
                ))}
              </div>
            )}
            {tab === 'AI' && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                AI effects run locally only. Whisper auto-captions are wired and ready; background-remove / face-track require a local model — drop one in resources/ and Snipette will detect it.
              </div>
            )}
            {selectedClipIds.length === 0 && (
              <div style={{ marginTop: 14, fontSize: 10.5, color: 'var(--text-muted)' }}>
                Tip: select one or two clips first to apply an effect.
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Two-layer animated preview of a transition. Layer A is a warm gradient, Layer B is a cool
 * gradient. Both have CSS keyframe animations tied to the transition type that cycle every
 * 3s — A→B→A — so the preview loops naturally.
 */
function TransitionPreviewCard({
  type,
  name,
  description,
  onApply,
}: {
  type: string;
  name: string;
  description: string;
  onApply: () => void;
}) {
  return (
    <button onClick={onApply} title={description} style={{ textAlign: 'left', background: 'transparent', padding: 0 }}>
      <div
        style={{
          aspectRatio: '4/3',
          borderRadius: 8,
          background: '#0a0a10',
          position: 'relative',
          overflow: 'hidden',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {/* Layer A — warm gradient with letter A */}
        <div
          className={`sn-trans-${type}-a`}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(135deg, #f23ac8, #f2a83a)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#0a0a0c',
            fontFamily: 'var(--font-display)',
            fontSize: 48,
            fontWeight: 800,
            textShadow: '0 2px 6px rgba(0,0,0,0.3)',
          }}
        >
          A
        </div>
        {/* Layer B — cool gradient with letter B (sits on top) */}
        <div
          className={`sn-trans-${type}-b`}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(135deg, #3ac8f2, #c8f23a)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#0a0a0c',
            fontFamily: 'var(--font-display)',
            fontSize: 48,
            fontWeight: 800,
            textShadow: '0 2px 6px rgba(0,0,0,0.3)',
          }}
        >
          B
        </div>
      </div>
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{name}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{description}</div>
      </div>
    </button>
  );
}

/**
 * Filter preview: a stylized reference scene (sky + landscape via gradients) with the actual
 * CSS `filter:` applied so the user sees the color shift live.
 */
function FilterPreviewCard({
  name,
  cssFilter,
  onApply,
}: {
  name: string;
  cssFilter: string;
  onApply: () => void;
}) {
  return (
    <button onClick={onApply} title={`Apply ${name}`} style={{ textAlign: 'left', background: 'transparent', padding: 0 }}>
      <div
        style={{
          aspectRatio: '4/3',
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid var(--border-subtle)',
          filter: cssFilter || undefined,
        }}
      >
        <ReferenceScene />
      </div>
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{name}</div>
      </div>
    </button>
  );
}

/** A small stylized "photo" made of gradients — same image is used to preview every filter. */
function ReferenceScene() {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: 'linear-gradient(180deg, #ffb37a 0%, #f06b6b 35%, #6b4280 65%, #2a2a55 100%)' }}>
      {/* Sun */}
      <div
        style={{
          position: 'absolute',
          top: '20%',
          left: '55%',
          width: '20%',
          aspectRatio: '1',
          borderRadius: '50%',
          background: 'radial-gradient(circle, #ffe7a8 0%, #ffb37a 60%, rgba(255,179,122,0) 100%)',
        }}
      />
      {/* Ocean strip */}
      <div
        style={{
          position: 'absolute',
          bottom: '28%',
          left: 0,
          right: 0,
          height: 8,
          background: 'linear-gradient(90deg, rgba(255,255,255,0.4), transparent)',
        }}
      />
      {/* Landscape */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: '30%',
          background: 'linear-gradient(180deg, #1a3a4a 0%, #0a1428 100%)',
          clipPath: 'polygon(0% 60%, 22% 25%, 38% 50%, 58% 18%, 78% 45%, 100% 32%, 100% 100%, 0% 100%)',
        }}
      />
      {/* Person silhouette */}
      <div
        style={{
          position: 'absolute',
          bottom: '8%',
          left: '38%',
          width: 6,
          height: '18%',
          background: '#0a0a0c',
          borderRadius: 2,
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: '24%',
          left: '36.2%',
          width: 10,
          height: 10,
          background: '#0a0a0c',
          borderRadius: '50%',
        }}
      />
    </div>
  );
}

function MotionFxCard({
  type,
  name,
  description,
  defaultIntensity,
}: {
  type: MotionFxType;
  name: string;
  description: string;
  defaultIntensity: number;
}) {
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const clips = useTimelineStore((s) => s.clips);
  const replaceClip = useTimelineStore((s) => s.replaceClip);
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const pushToast = useEditorStore((s) => s.pushToast);

  // Already-applied detection: any selected clip already has this effect?
  const appliedOnAllSelected =
    selectedClipIds.length > 0 &&
    selectedClipIds.every((id) => {
      const c = clips.find((cc) => cc.id === id);
      return !!c && parseEffects(c.effects_json).some((e) => e.type === type);
    });

  const apply = async () => {
    if (selectedClipIds.length === 0) {
      pushToast({ kind: 'info', message: 'Select a clip first.' });
      return;
    }
    pushHistory();
    for (const id of selectedClipIds) {
      const c = clips.find((cc) => cc.id === id);
      if (!c) continue;
      const current = parseEffects(c.effects_json);
      // Toggle: if already present remove it, otherwise append a new entry.
      const next = current.some((e) => e.type === type)
        ? current.filter((e) => e.type !== type)
        : [...current, { type, intensity: defaultIntensity }];
      const updated = await window.snipette.timeline.updateClip(id, {
        effects_json: serializeEffects(next),
      });
      replaceClip(updated);
    }
    pushToast({
      kind: 'success',
      message: appliedOnAllSelected ? `${name} removed` : `${name} applied`,
    });
  };

  // Live looping preview built with CSS keyframes (defined in globals.css). Each effect type
  // has its own `.sn-fx-preview-{type}` class.
  const previewClass = `sn-fx-preview-${type}`;

  return (
    <button
      onClick={apply}
      title={description}
      style={{
        textAlign: 'left',
        background: 'transparent',
        padding: 0,
      }}
    >
      <div
        style={{
          aspectRatio: '4/3',
          borderRadius: 8,
          border: `1.5px solid ${appliedOnAllSelected ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
          background: 'linear-gradient(135deg, #3a2614, #1a1410)',
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          className={previewClass}
          style={{
            width: '60%',
            height: '60%',
            borderRadius: 6,
            background: 'linear-gradient(160deg, #c8f23a, #f2a83a)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          }}
        />
        {appliedOnAllSelected && (
          <div
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              background: 'var(--accent-primary)',
              color: '#0A0A0C',
              fontSize: 9,
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: 4,
              letterSpacing: 0.4,
            }}
          >
            ON
          </div>
        )}
      </div>
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{name}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{description}</div>
      </div>
    </button>
  );
}
