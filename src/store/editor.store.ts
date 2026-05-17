import { create } from 'zustand';

interface ToastItem {
  id: string;
  kind: 'info' | 'success' | 'error';
  message: string;
}

export type ContextMenuItem =
  | { kind?: 'item'; label: string; danger?: boolean; disabled?: boolean; hint?: string; onClick: () => void }
  | { kind: 'separator' }
  | { kind: 'header'; label: string };

interface EditorState {
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  showSafeZones: boolean;
  showFullscreenPreview: boolean;
  previewVolume: number;
  previewMuted: boolean;
  leftPanelTab: 'library' | 'layers';
  proxyProgress: Map<string, number>;
  effectsDrawerOpen: boolean;
  exportModalOpen: boolean;
  formatPickerOpen: boolean;
  shortcutsModalOpen: boolean;
  settingsOpen: boolean;
  onboardingOpen: boolean;
  voiceStudioOpen: boolean;
  dialogueOpen: boolean;
  contextMenu: {
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null;
  stickerPicker: { x: number; y: number; atTimeMs: number } | null;
  transitionPicker: {
    x: number;
    y: number;
    projectId: string;
    trackId: string;
    clipAId: string;
    clipBId: string;
  } | null;
  toasts: ToastItem[];
  /**
   * Asset currently being dragged from the media library, or null. Lets the timeline
   * preview the drop position during HTML5 `dragover` events — `dataTransfer.getData`
   * is unreadable during dragover in Chromium, so we shadow the asset ID here.
   */
  draggingAssetId: string | null;

  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  toggleSafeZones: () => void;
  toggleFullscreenPreview: () => void;
  setPreviewVolume: (v: number) => void;
  togglePreviewMuted: () => void;
  setLeftPanelTab: (tab: 'library' | 'layers') => void;
  setProxyProgress: (assetId: string, percent: number) => void;
  clearProxyProgress: (assetId: string) => void;
  openEffectsDrawer: () => void;
  closeEffectsDrawer: () => void;
  openExport: () => void;
  closeExport: () => void;
  openFormatPicker: () => void;
  closeFormatPicker: () => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openOnboarding: () => void;
  closeOnboarding: () => void;
  openVoiceStudio: () => void;
  closeVoiceStudio: () => void;
  openDialogue: () => void;
  closeDialogue: () => void;
  setContextMenu: (m: EditorState['contextMenu']) => void;
  openStickerPicker: (p: { x: number; y: number; atTimeMs: number }) => void;
  closeStickerPicker: () => void;
  openTransitionPicker: (p: NonNullable<EditorState['transitionPicker']>) => void;
  closeTransitionPicker: () => void;
  pushToast: (toast: Omit<ToastItem, 'id'>) => void;
  dismissToast: (id: string) => void;
  setDraggingAssetId: (assetId: string | null) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  leftPanelOpen: true,
  rightPanelOpen: true,
  showSafeZones: true,
  showFullscreenPreview: false,
  previewVolume: 1,
  previewMuted: false,
  leftPanelTab: 'library',
  proxyProgress: new Map(),
  effectsDrawerOpen: false,
  exportModalOpen: false,
  formatPickerOpen: false,
  shortcutsModalOpen: false,
  settingsOpen: false,
  onboardingOpen: false,
  voiceStudioOpen: false,
  dialogueOpen: false,
  contextMenu: null,
  stickerPicker: null,
  transitionPicker: null,
  toasts: [],
  draggingAssetId: null,

  toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  toggleSafeZones: () => set((s) => ({ showSafeZones: !s.showSafeZones })),
  toggleFullscreenPreview: () => set((s) => ({ showFullscreenPreview: !s.showFullscreenPreview })),
  setPreviewVolume: (v) => set({ previewVolume: Math.max(0, Math.min(1, v)), previewMuted: v === 0 }),
  togglePreviewMuted: () => set((s) => ({ previewMuted: !s.previewMuted })),
  setLeftPanelTab: (tab) => set({ leftPanelTab: tab }),
  setProxyProgress: (assetId, percent) =>
    set((s) => {
      const next = new Map(s.proxyProgress);
      next.set(assetId, percent);
      return { proxyProgress: next };
    }),
  clearProxyProgress: (assetId) =>
    set((s) => {
      if (!s.proxyProgress.has(assetId)) return s;
      const next = new Map(s.proxyProgress);
      next.delete(assetId);
      return { proxyProgress: next };
    }),
  openEffectsDrawer: () => set({ effectsDrawerOpen: true }),
  closeEffectsDrawer: () => set({ effectsDrawerOpen: false }),
  openExport: () => set({ exportModalOpen: true }),
  closeExport: () => set({ exportModalOpen: false }),
  openFormatPicker: () => set({ formatPickerOpen: true }),
  closeFormatPicker: () => set({ formatPickerOpen: false }),
  openShortcuts: () => set({ shortcutsModalOpen: true }),
  closeShortcuts: () => set({ shortcutsModalOpen: false }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openOnboarding: () => set({ onboardingOpen: true }),
  closeOnboarding: () => set({ onboardingOpen: false }),
  openVoiceStudio: () => set({ voiceStudioOpen: true }),
  closeVoiceStudio: () => set({ voiceStudioOpen: false }),
  openDialogue: () => set({ dialogueOpen: true }),
  closeDialogue: () => set({ dialogueOpen: false }),
  setContextMenu: (m) => set({ contextMenu: m }),
  openStickerPicker: (p) => set({ stickerPicker: p }),
  closeStickerPicker: () => set({ stickerPicker: null }),
  openTransitionPicker: (p) => set({ transitionPicker: p }),
  closeTransitionPicker: () => set({ transitionPicker: null }),
  pushToast: (toast) =>
    set((s) => ({
      toasts: [...s.toasts, { ...toast, id: crypto.randomUUID() }].slice(-5),
    })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setDraggingAssetId: (assetId) => set({ draggingAssetId: assetId }),
}));
