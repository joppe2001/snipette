import { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Hub } from '@/routes/Hub';
import { Editor } from '@/routes/Editor';
import { FormatPicker } from '@/components/modals/FormatPicker';
import { ExportModal } from '@/components/modals/ExportModal';
import { ShortcutsModal } from '@/components/modals/ShortcutsModal';
import { SettingsModal } from '@/components/modals/SettingsModal';
import { OnboardingModal } from '@/components/modals/OnboardingModal';
import { VoiceStudioModal } from '@/components/modals/VoiceStudioModal';
import { DialogueModal } from '@/components/modals/DialogueModal';
import { ContextMenu } from '@/components/ui/ContextMenu';
import { StickerPicker } from '@/components/editor/StickerPicker';
import { TransitionPicker } from '@/components/editor/TransitionPicker';
import { ToastStack } from '@/components/ui/Toast';
import { useSettingsStore } from '@/store/settings.store';
import { useEditorStore } from '@/store/editor.store';
import { useProjectStore } from '@/store/project.store';

export function App(): JSX.Element {
  const loadSettings = useSettingsStore((s) => s.load);
  const openOnboarding = useEditorStore((s) => s.openOnboarding);
  const activeProject = useProjectStore((s) => s.activeProject);

  useEffect(() => {
    void loadSettings().then(async () => {
      const seen = await window.snipette.settings.get('onboarded');
      if (!seen) openOnboarding();
      // The "seen" flag is now set by the OnboardingModal itself when the user finishes or skips,
      // not the moment it opens — so a crash mid-onboarding doesn't trap the user out of it.
    });
  }, [loadSettings, openOnboarding]);

  /**
   * Autosave snapshots: every N minutes (settable via Settings → General → "Autosave every"),
   * snapshot the active project's SQLite state to disk. The snapshot service prunes after 20
   * per project, so this never grows unbounded. Disabled when interval is 0.
   */
  useEffect(() => {
    if (!activeProject) return;
    const settings = useSettingsStore.getState().values;
    // Settings stores seconds. Autosave_interval_seconds=0 disables it.
    const secs = parseInt(settings.autosave_interval_seconds ?? '900', 10);
    if (!Number.isFinite(secs) || secs <= 0) return;
    const periodMs = Math.max(30_000, secs * 1000); // floor at 30 s
    const id = setInterval(() => {
      void window.snipette.backup.createSnapshot(activeProject.id).catch(() => {
        // Silent — autosave failures aren't worth a toast.
      });
    }, periodMs);
    return () => clearInterval(id);
  }, [activeProject]);

  return (
    <HashRouter>
      <div style={{ width: '100%', height: '100%' }}>
        <Routes>
          <Route path="/" element={<Hub />} />
          <Route path="/editor/:id" element={<Editor />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>

        <FormatPicker />
        <ExportModal />
        <ShortcutsModal />
        <SettingsModal />
        <OnboardingModal />
        <VoiceStudioModal />
        <DialogueModal />
        <ContextMenu />
        <StickerPicker />
        <TransitionPicker />
        <ToastStack />
      </div>
    </HashRouter>
  );
}
