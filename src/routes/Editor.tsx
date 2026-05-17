import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useProjectStore } from '@/store/project.store';
import { useTimelineStore } from '@/store/timeline.store';
import { useEditorStore } from '@/store/editor.store';
import { usePlayback } from '@/hooks/usePlayback';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useFileDrop } from '@/hooks/useDragDrop';
import { TopBar } from '@/components/editor/TopBar';
import { LeftPanel } from '@/components/editor/LeftPanel';
import { PreviewCanvas } from '@/components/editor/PreviewCanvas';
import { RightPanel } from '@/components/editor/RightPanel';
import { Timeline } from '@/components/editor/Timeline';
import { EffectsDrawer } from '@/components/editor/EffectsDrawer';

export function Editor(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const project = useProjectStore((s) => s.activeProject);
  const openProject = useProjectStore((s) => s.openProject);
  const load = useTimelineStore((s) => s.load);
  const reset = useTimelineStore((s) => s.reset);
  const computeDuration = useTimelineStore((s) => s.computeDuration);
  const leftPanelOpen = useEditorStore((s) => s.leftPanelOpen);
  const rightPanelOpen = useEditorStore((s) => s.rightPanelOpen);
  const importMedia = useProjectStore((s) => s.importMedia);
  const upsertAsset = useProjectStore((s) => s.upsertAsset);
  const pushToast = useEditorStore((s) => s.pushToast);
  const setProxyProgress = useEditorStore((s) => s.setProxyProgress);
  const clearProxyProgress = useEditorStore((s) => s.clearProxyProgress);
  const proxyProgress = useEditorStore((s) => s.proxyProgress);

  // Hydrate
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        const project = await openProject(id);
        const tl = await window.snipette.timeline.list(id);
        if (cancelled) return;
        load(id, tl, project.duration_ms);
        computeDuration();
      } catch (e) {
        console.error(e);
        navigate('/');
      }
    })();
    return () => {
      cancelled = true;
      reset();
    };
  }, [id, openProject, load, reset, computeDuration, navigate]);

  // Listen for background proxy completion so the video element auto-switches to the H.264
  // proxy as soon as it's ready.
  useEffect(() => {
    const off = window.snipette.media.onAssetUpdated((asset) => {
      upsertAsset(asset);
      clearProxyProgress(asset.id);
    });
    return off;
  }, [upsertAsset, clearProxyProgress]);

  useEffect(() => {
    const off = window.snipette.media.onProxyProgress(({ assetId, percent }) => {
      setProxyProgress(assetId, percent);
    });
    return off;
  }, [setProxyProgress]);

  // Playback driver
  usePlayback();
  useKeyboardShortcuts();

  // Timeline height (resizable + collapsible via the drag handle). Persisted to
  // localStorage so it survives reloads. Min 36px shows just the ruler ("collapsed"),
  // max leaves at least 200px for the preview area.
  const [timelineH, setTimelineH] = useState<number>(() => {
    const stored = Number(localStorage.getItem('sn:timelineH'));
    if (stored >= 36 && stored <= 4000) return stored;
    return Math.round(window.innerHeight * 0.38);
  });
  const [draggingDivider, setDraggingDivider] = useState(false);
  const lastSavedHRef = useRef(timelineH);
  useEffect(() => {
    if (lastSavedHRef.current !== timelineH) {
      localStorage.setItem('sn:timelineH', String(timelineH));
      lastSavedHRef.current = timelineH;
    }
  }, [timelineH]);
  // Toggle collapse: stash current height when collapsing so re-expand restores it.
  const collapsedRef = useRef<number | null>(null);
  const toggleTimelineCollapse = () => {
    if (timelineH <= 40) {
      setTimelineH(collapsedRef.current ?? Math.round(window.innerHeight * 0.38));
      collapsedRef.current = null;
    } else {
      collapsedRef.current = timelineH;
      setTimelineH(36);
    }
  };
  useEffect(() => {
    if (!draggingDivider) return;
    const onMove = (e: MouseEvent) => {
      const topBarH = 44; // matches TopBar height
      const minTimeline = 36;
      const maxTimeline = Math.max(minTimeline, window.innerHeight - topBarH - 200);
      const next = window.innerHeight - e.clientY;
      setTimelineH(Math.max(minTimeline, Math.min(maxTimeline, next)));
    };
    const onUp = () => setDraggingDivider(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [draggingDivider]);

  // Drop zone
  const { dragging } = useFileDrop(async (paths) => {
    try {
      const newAssets = await importMedia(paths);
      if (newAssets.length) {
        pushToast({ kind: 'success', message: `Imported ${newAssets.length} file${newAssets.length === 1 ? '' : 's'}.` });
      }
    } catch (e) {
      pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Import failed' });
    }
  });

  if (!project) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-secondary)' }}>
        Loading project…
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'grid',
          gridTemplateRows: `44px minmax(0,1fr) 6px ${timelineH}px`,
        }}
      >
        <TopBar />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `${leftPanelOpen ? '200px' : '0px'} 1fr ${rightPanelOpen ? '300px' : '0px'}`,
            minHeight: 0,
            transition: 'grid-template-columns .15s ease',
          }}
        >
          {leftPanelOpen && <LeftPanel />}
          <PreviewCanvas />
          {rightPanelOpen && <RightPanel />}
        </div>
        {/* Draggable divider — drag vertically to resize the timeline; double-click
            to collapse to just the ruler / restore to last height. */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            setDraggingDivider(true);
          }}
          onDoubleClick={toggleTimelineCollapse}
          title="Drag to resize · double-click to collapse"
          style={{
            cursor: 'row-resize',
            background: draggingDivider ? 'var(--accent-primary)' : 'var(--border-subtle)',
            transition: draggingDivider ? 'none' : 'background .12s ease',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onMouseEnter={(e) => {
            if (!draggingDivider) e.currentTarget.style.background = 'var(--accent-primary)';
          }}
          onMouseLeave={(e) => {
            if (!draggingDivider) e.currentTarget.style.background = 'var(--border-subtle)';
          }}
        >
          {/* Grip dots for affordance */}
          <span style={{ display: 'flex', gap: 3, pointerEvents: 'none', opacity: 0.6 }}>
            <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--bg-base)' }} />
            <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--bg-base)' }} />
            <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--bg-base)' }} />
          </span>
        </div>
        <div style={{ minHeight: 0, overflow: 'hidden' }}>
          <Timeline />
        </div>
      </div>

      <EffectsDrawer />

      {dragging && (
        <div className="sn-drop-overlay">
          DROP FOOTAGE TO IMPORT
        </div>
      )}

      {proxyProgress.size > 0 && !leftPanelOpen && (
        <div
          style={{
            position: 'absolute',
            bottom: 12,
            left: 12,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 11,
            color: 'var(--text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            zIndex: 50,
          }}
        >
          <span className="sn-spin" style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid var(--accent-primary)', borderRightColor: 'transparent', display: 'inline-block' }} />
          Generating preview proxy · {Math.round(Array.from(proxyProgress.values()).reduce((a, b) => a + b, 0) / proxyProgress.size)}%
        </div>
      )}
    </div>
  );
}
