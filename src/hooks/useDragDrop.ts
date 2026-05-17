import { useEffect, useRef, useState } from 'react';

export interface DragDropState {
  dragging: boolean;
}

/**
 * Window-level file drop.
 *
 * We use `dragover` (fires continuously while a file is hovering over the window) plus a short
 * inactivity timeout instead of paired dragenter/dragleave counters — those break across nested
 * elements and cause the overlay to flicker on/off as the cursor crosses child boundaries.
 *
 * Electron 32+ removed the non-standard `File.path` property; paths now come from
 * `webUtils.getPathForFile(file)`, which we surface through the preload bridge.
 */
export function useFileDrop(onDropPaths: (paths: string[]) => void): DragDropState {
  const [dragging, setDragging] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const clearIdleTimer = () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      setDragging(true);
      clearIdleTimer();
      // If the cursor leaves the window the events stop, so a short idle window dismisses the overlay.
      timeoutRef.current = window.setTimeout(() => {
        setDragging(false);
        timeoutRef.current = null;
      }, 120);
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      clearIdleTimer();
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const paths: string[] = [];
      for (const f of files) {
        try {
          const p = window.snipette.getPathForFile(f);
          if (p) paths.push(p);
        } catch {
          // Web File without an underlying disk path — skip silently.
        }
      }
      if (paths.length) onDropPaths(paths);
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      clearIdleTimer();
    };
  }, [onDropPaths]);

  return { dragging };
}
