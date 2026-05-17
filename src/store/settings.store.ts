import { create } from 'zustand';

interface SettingsState {
  values: Record<string, string>;
  whisperAvailable: boolean;
  load: () => Promise<void>;
  set: (key: string, value: string) => Promise<void>;
  reset: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  values: {},
  whisperAvailable: false,

  load: async () => {
    const [values, whisperAvailable] = await Promise.all([
      window.snipette.settings.all(),
      window.snipette.system.whisperAvailable(),
    ]);
    set({ values, whisperAvailable });
  },

  set: async (key, value) => {
    await window.snipette.settings.set(key, value);
    set((s) => ({ values: { ...s.values, [key]: value } }));
  },

  reset: async () => {
    await window.snipette.settings.reset();
    const values = await window.snipette.settings.all();
    set({ values });
  },
}));
