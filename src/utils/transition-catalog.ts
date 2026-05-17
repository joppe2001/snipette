/**
 * Single source of truth for the transition library. The EffectsDrawer Transitions tab,
 * the gap-add "+" popover, and the right-click "Change type" menu all reference this list.
 */
export interface TransitionDef {
  type: string;
  name: string;
  description: string;
}

export const TRANSITION_CATALOG: TransitionDef[] = [
  { type: 'cut', name: 'Cut', description: 'Hard cut' },
  { type: 'dissolve', name: 'Dissolve', description: 'Opacity crossfade' },
  { type: 'slide', name: 'Slide', description: 'Slide off / slide in' },
  { type: 'push', name: 'Push', description: 'Incoming pushes outgoing off' },
  { type: 'wipe', name: 'Wipe', description: 'Linear left-to-right reveal' },
  { type: 'iris', name: 'Iris', description: 'Circular reveal from center' },
  { type: 'zoom', name: 'Zoom', description: 'Zoom in to swap' },
  { type: 'spin', name: 'Spin', description: 'Rotate + scale swap' },
  { type: 'bounce', name: 'Bounce', description: 'Bouncy scale swap' },
  { type: 'smooth', name: 'Smooth', description: 'Soft blur slide' },
  { type: 'glitch', name: 'Glitch', description: 'Jitter + chromatic' },
  { type: 'whip', name: 'Whip', description: 'Fast slide + motion blur' },
];

export function transitionDef(type: string): TransitionDef | undefined {
  return TRANSITION_CATALOG.find((t) => t.type === type);
}
