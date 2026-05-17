import type { SnipetteApi } from '../../electron/preload';

declare global {
  interface Window {
    snipette: SnipetteApi;
  }
}

export {};
