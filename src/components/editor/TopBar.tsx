import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Icons, Mark } from '@/components/ui/icons';
import { useProjectStore } from '@/store/project.store';
import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import { relativeTimeAgo } from '@/utils/time';
import { DEFAULT_TEXT_ANIM, type TextAnimationSpec } from '@/utils/text-animation';
import { COMPOUND_TEMPLATES, type TextStyleFull } from '@/utils/text-templates';

export function TopBar(): JSX.Element {
  const navigate = useNavigate();
  const project = useProjectStore((s) => s.activeProject);
  const renameProject = useProjectStore((s) => s.renameProject);
  const undo = useTimelineStore((s) => s.undo);
  const redo = useTimelineStore((s) => s.redo);
  const openExport = useEditorStore((s) => s.openExport);
  const openEffects = useEditorStore((s) => s.openEffectsDrawer);
  const pushToast = useEditorStore((s) => s.pushToast);

  /**
   * Spawn (or focus) a transcript-mode text clip. Lives on a dedicated text
   * track called "Transcript" so we never collide with the user's other text
   * clips. If a transcript clip already exists we just select it — there's no
   * benefit to multiple transcript clips on the same project, and the user
   * almost certainly wants to keep editing the same one.
   */
  const addTranscript = async () => {
    if (!project) return;
    const tracks = useTimelineStore.getState().tracks;
    const clips = useTimelineStore.getState().clips;
    // Already have a transcript clip? Just select it.
    const existing = clips.find((c) => {
      if (!c.text_animation_json) return false;
      try {
        const raw = JSON.parse(c.text_animation_json) as Record<string, unknown>;
        return Array.isArray(raw.transcript_entries);
      } catch {
        return false;
      }
    });
    if (existing) {
      useTimelineStore.getState().selectClip(existing.id);
      pushToast({ kind: 'info', message: 'Transcript clip selected — edit entries in the inspector.' });
      return;
    }

    let textTrack = tracks.find((t) => t.type === 'text' && t.name === 'Transcript')
      ?? tracks.find((t) => t.type === 'text');
    useTimelineStore.getState().pushHistory();
    if (!textTrack) {
      try {
        textTrack = await window.snipette.timeline.addTrack({
          project_id: project.id,
          type: 'text',
          name: 'Transcript',
        });
        useTimelineStore.getState().upsertTrack(textTrack);
      } catch {
        pushToast({ kind: 'error', message: 'Failed to add transcript track.' });
        return;
      }
    }
    // Pull title/subtitle styles from the Translation compound template so the
    // transcript inherits the same translation-on-top, original-bigger-below
    // look out of the box. Editor can restyle freely from the inspector.
    const tpl = COMPOUND_TEMPLATES.find((t) => t.id === 'translation');
    const titleStyle: TextStyleFull = tpl?.clip.titleStyle ?? ({} as TextStyleFull);
    const subtitleStyle: TextStyleFull = tpl?.clip.subtitleStyle ?? ({} as TextStyleFull);
    // Span the whole project so the editor never runs out of room. If the
    // project is empty (duration 0) we still drop a 30s buffer so the clip is
    // visible and resizeable on the timeline.
    const durationMs = useTimelineStore.getState().durationMs;
    const clipDuration = Math.max(durationMs - useTimelineStore.getState().playheadMs, 30_000);
    try {
      const created = await window.snipette.timeline.addClip(textTrack.id, {
        track_id: textTrack.id,
        project_id: project.id,
        start_time_ms: Math.max(0, useTimelineStore.getState().playheadMs),
        duration_ms: clipDuration,
        source_in_ms: 0,
        source_out_ms: clipDuration,
        text_content: '',
        text_style_json: JSON.stringify(titleStyle),
      });
      const anim: TextAnimationSpec = {
        ...DEFAULT_TEXT_ANIM,
        compound_role: 'title',
        subtitle_text: '',
        subtitle_style_json: JSON.stringify(subtitleStyle),
        transcript_entries: [],
        transcript_fade_ms: 0,
      };
      const positioned = await window.snipette.timeline.updateClip(created.id, {
        text_animation_json: JSON.stringify(anim),
      });
      useTimelineStore.getState().addClip(positioned);
      useTimelineStore.getState().selectClip(positioned.id);
      useTimelineStore.getState().computeDuration();
      pushToast({
        kind: 'success',
        message: 'Transcript clip added — open the inspector and click "Add entry" to begin.',
      });
    } catch (e) {
      pushToast({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Could not add transcript.',
      });
    }
  };
  const [isEditingName, setIsEditingName] = useState(false);
  const [draftName, setDraftName] = useState(project?.name ?? '');
  const [lastSaved, setLastSaved] = useState<number>(project?.updated_at ?? Date.now());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (project) setDraftName(project.name);
  }, [project?.name]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  if (!project) return <div />;

  const commitName = async () => {
    setIsEditingName(false);
    if (draftName.trim() && draftName !== project.name) {
      await renameProject(project.id, draftName.trim());
      setLastSaved(Date.now());
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        // Extra left padding on macOS to clear the traffic-light buttons.
        paddingLeft: navigator.platform.startsWith('Mac') ? 80 : 16,
        paddingRight: 16,
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg-base)',
        height: 44,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <button
        className="sn-icon-btn"
        onClick={() => navigate('/')}
        title="Back to projects"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Icons.ArrowLeft size={16} />
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Mark size={18} />
        <span className="display" style={{ fontSize: 14, letterSpacing: '0.04em', opacity: 0.75 }}>SNIPETTE</span>
      </div>
      <div style={{ width: 1, height: 20, background: 'var(--border-subtle)' }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {isEditingName ? (
          <input
            value={draftName}
            autoFocus
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              else if (e.key === 'Escape') {
                setDraftName(project.name);
                setIsEditingName(false);
              }
            }}
            style={{
              fontWeight: 600,
              fontSize: 13,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 4,
              padding: '3px 8px',
              minWidth: 200,
            }}
          />
        ) : (
          <button
            onDoubleClick={() => setIsEditingName(true)}
            style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}
            title="Double-click to rename"
          >
            {project.name}
          </button>
        )}
      </div>
      <span className="sn-pill">
        <span className="dot" style={{ background: 'var(--accent-primary)' }} />
        {project.format} · {project.fps}fps
      </span>

      <div style={{ flex: 1 }} />

      <span
        className="mono"
        style={{ fontSize: 10.5, color: 'var(--text-secondary)', letterSpacing: 0.4, display: 'inline-flex', alignItems: 'center', gap: 6 }}
        key={tick}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-primary)', display: 'inline-block' }} />
        SAVED · {relativeTimeAgo(lastSaved)}
      </span>
      <div style={{ display: 'flex', gap: 2, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button className="sn-icon-btn" onClick={undo} title="Undo ⌘Z">
          <Icons.Undo size={15} />
        </button>
        <button className="sn-icon-btn" onClick={redo} title="Redo ⌘⇧Z">
          <Icons.Redo size={15} />
        </button>
      </div>
      <div style={{ width: 1, height: 20, background: 'var(--border-subtle)' }} />
      <button
        className="sn-btn-ghost"
        onClick={() => void addTranscript()}
        title="Add a transcript clip — one overlay, many timed entries"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Icons.Caption size={13} /> Transcript
      </button>
      <button
        className="sn-btn-ghost"
        onClick={openEffects}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Icons.Sparkle size={13} /> Effects
      </button>
      <button
        className="sn-btn-primary"
        onClick={openExport}
        title="Export… (⌘E)"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        Export <Icons.Arrow size={13} stroke="#0A0A0C" />
      </button>
    </div>
  );
}
