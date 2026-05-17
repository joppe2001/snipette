import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useEditorStore } from '@/store/editor.store';
import { Icons } from '@/components/ui/icons';

const STEPS = [
  {
    title: 'Welcome to Snipette',
    body: 'A local-first video editor for creators making vertical content. Nothing leaves this machine.',
    accent: 'Privacy first',
  },
  {
    title: 'Drop footage anywhere',
    body: 'Drag video, audio, or images into the window. Snipette generates proxies and waveforms in the background.',
    accent: 'Instant import',
  },
  {
    title: 'Cut. Caption. Export.',
    body: 'Press B for the razor tool, T for text. Auto-captions use whisper.cpp locally. Press ? for the full shortcut sheet.',
    accent: 'You are ready',
  },
];

export function OnboardingModal(): JSX.Element {
  const open = useEditorStore((s) => s.onboardingOpen);
  const close = useEditorStore((s) => s.closeOnboarding);
  const [step, setStep] = useState(0);
  const s = STEPS[step];

  const markSeen = () => {
    void window.snipette.settings.set('onboarded', '1');
  };

  const dismiss = () => {
    markSeen();
    close();
  };

  const next = () => {
    if (step < STEPS.length - 1) setStep(step + 1);
    else dismiss();
  };

  return (
    <Modal open={open} onClose={dismiss} width={520}>
      <div style={{ padding: 32 }}>
        <div className="sn-section-label" style={{ color: 'var(--accent-primary)' }}>{s.accent}</div>
        <div className="display" style={{ fontSize: 32, marginTop: 8, lineHeight: 1.05 }}>{s.title}</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 14, maxWidth: 420 }}>{s.body}</div>

        <div style={{ display: 'flex', gap: 4, marginTop: 22 }}>
          {STEPS.map((_, i) => (
            <div
              key={i}
              style={{
                width: 28,
                height: 4,
                borderRadius: 2,
                background: i <= step ? 'var(--accent-primary)' : 'var(--bg-elevated)',
              }}
            />
          ))}
        </div>

        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'space-between' }}>
          <button className="sn-btn-ghost" onClick={dismiss}>Skip</button>
          <button className="sn-btn-primary" onClick={next}>
            {step === STEPS.length - 1 ? "Let's go" : 'Next'} <Icons.Arrow size={13} stroke="#0A0A0C" />
          </button>
        </div>
      </div>
    </Modal>
  );
}
