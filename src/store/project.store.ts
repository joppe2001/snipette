import { create } from 'zustand';
import type { MediaAsset, Project } from '@shared/types';

interface ProjectState {
  activeProject: Project | null;
  projects: Project[];
  assets: MediaAsset[];
  loadProjects: () => Promise<void>;
  createProject: (opts: { name: string; format: Project['format']; width: number; height: number; fps: number }) => Promise<Project>;
  openProject: (id: string) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  duplicateProject: (id: string) => Promise<Project>;
  importMedia: (paths: string[]) => Promise<MediaAsset[]>;
  refreshAssets: () => Promise<void>;
  upsertAsset: (asset: MediaAsset) => void;
  removeAsset: (assetId: string) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  activeProject: null,
  projects: [],
  assets: [],

  loadProjects: async () => {
    const list = await window.snipette.project.list();
    set({ projects: list });
  },

  createProject: async (opts) => {
    const p = await window.snipette.project.create(opts);
    set((s) => ({ projects: [p, ...s.projects] }));
    return p;
  },

  openProject: async (id) => {
    const p = await window.snipette.project.open(id);
    const assets = await window.snipette.media.list(id);
    set({ activeProject: p, assets });
    return p;
  },

  deleteProject: async (id) => {
    await window.snipette.project.delete(id);
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      activeProject: s.activeProject?.id === id ? null : s.activeProject,
    }));
  },

  renameProject: async (id, name) => {
    await window.snipette.project.rename(id, name);
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
      activeProject:
        s.activeProject?.id === id ? { ...s.activeProject, name } : s.activeProject,
    }));
  },

  duplicateProject: async (id) => {
    const dup = await window.snipette.project.duplicate(id);
    set((s) => ({ projects: [dup, ...s.projects] }));
    return dup;
  },

  importMedia: async (paths) => {
    const project = get().activeProject;
    if (!project) throw new Error('No active project');
    const newAssets = await window.snipette.media.import(project.id, paths);
    set((s) => ({ assets: [...s.assets, ...newAssets] }));
    return newAssets;
  },

  refreshAssets: async () => {
    const project = get().activeProject;
    if (!project) return;
    const assets = await window.snipette.media.list(project.id);
    set({ assets });
  },

  upsertAsset: (asset) =>
    set((s) => {
      const idx = s.assets.findIndex((a) => a.id === asset.id);
      if (idx === -1) return { assets: [...s.assets, asset] };
      const next = s.assets.slice();
      next[idx] = asset;
      return { assets: next };
    }),

  removeAsset: (assetId) =>
    set((s) => ({ assets: s.assets.filter((a) => a.id !== assetId) })),
}));
