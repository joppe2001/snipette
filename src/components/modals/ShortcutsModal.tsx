import { Modal } from '@/components/ui/Modal';
import { useEditorStore } from '@/store/editor.store';
import { Icons } from '@/components/ui/icons';

const SECTIONS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Playback',
    items: [
      ['Play / Pause', 'Space'],
      ['Play forward', 'L'],
      ['Pause', 'K'],
      ['Reverse (stub: -5 frames)', 'J'],
      ['Step forward 1 frame', '→'],
      ['Step back 1 frame', '←'],
      ['Step forward 10 frames', '⇧→'],
      ['Step back 10 frames', '⇧←'],
      ['Go to start', 'Home'],
      ['Go to end', 'End'],
    ],
  },
  {
    title: 'Tools',
    items: [
      ['Select', 'V'],
      ['Split / Razor', 'B'],
      ['Text', 'T'],
      ['Sticker', 'S'],
      ['Hand · pan', 'H'],
      ['Zoom · alt-click out', 'Z'],
      ['Slip edit (drag clip body)', '⌥-drag'],
    ],
  },
  {
    title: 'Editing',
    items: [
      ['Undo', '⌘Z'],
      ['Redo', '⌘⇧Z'],
      ['Select all', '⌘A'],
      ['Duplicate selected', '⌘D'],
      ['Split selected at playhead', '⌘B'],
      ['Rename selected clip / track', '⌘R'],
      ['Detach audio (stub)', '⌘⇧D'],
      ['Set in point on selected clip', 'I'],
      ['Set out point on selected clip', 'O'],
      ['Nudge clip 1 frame left / right', ', / .'],
      ['Nudge clip 10 frames left / right', '⇧, / ⇧.'],
      ['Move clip to track above / below', '⌥↑ / ⌥↓'],
      ['Toggle snap', 'N'],
      ['Delete', 'Delete / ⌫'],
      ['Ripple delete (close gap)', '⌥⌫'],
      ['Clear selection', 'Esc'],
    ],
  },
  {
    title: 'Markers',
    items: [
      ['Add marker at playhead', 'M'],
      ['Jump to previous marker', '['],
      ['Jump to next marker', ']'],
    ],
  },
  {
    title: 'Project',
    items: [
      ['Export', '⌘E'],
      ['Zoom in timeline', '⌘+'],
      ['Zoom out timeline', '⌘−'],
      ['Fit timeline', '⌘0'],
      ['Fullscreen preview', 'F'],
      ['Toggle safe zones', 'G'],
      ['Shortcuts panel', '?'],
    ],
  },
];

export function ShortcutsModal(): JSX.Element {
  const open = useEditorStore((s) => s.shortcutsModalOpen);
  const close = useEditorStore((s) => s.closeShortcuts);
  return (
    <Modal open={open} onClose={close} width={680}>
      <div style={{ padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div className="display" style={{ fontSize: 24, letterSpacing: '0.04em' }}>Keyboard shortcuts</div>
          <button className="sn-icon-btn" onClick={close}><Icons.X size={14} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 28 }}>
          {SECTIONS.map((s) => (
            <div key={s.title}>
              <div className="sn-section-label" style={{ marginBottom: 8 }}>{s.title}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {s.items.map(([label, keys]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, padding: '4px 0' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                    <span className="sn-kbd">{keys}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
