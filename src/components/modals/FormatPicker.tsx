import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Icons } from '@/components/ui/icons';
import { useEditorStore } from '@/store/editor.store';
import { useProjectStore } from '@/store/project.store';
import { useNavigate } from 'react-router-dom';
import type { Format } from '@shared/types';

interface FormatOpt {
  id: Format;
  ratio: string;
  size: string;
  label: string;
  tag?: string;
  width: number;
  height: number;
  Icon: typeof Icons.Phone;
}

const FORMATS: FormatOpt[] = [
  {
    id: '9:16',
    ratio: '9:16',
    size: '1080×1920',
    label: 'Vertical',
    tag: 'Most used',
    width: 1080,
    height: 1920,
    Icon: Icons.Phone,
  },
  { id: '16:9', ratio: '16:9', size: '1920×1080', label: 'Horizontal', width: 1920, height: 1080, Icon: Icons.Monitor },
  { id: '1:1', ratio: '1:1', size: '1080×1080', label: 'Square', width: 1080, height: 1080, Icon: Icons.Square },
];

const FPS_OPTIONS = [24, 30, 60, 120];

export function FormatPicker(): JSX.Element {
  const open = useEditorStore((s) => s.formatPickerOpen);
  const close = useEditorStore((s) => s.closeFormatPicker);
  const createProject = useProjectStore((s) => s.createProject);
  const openProject = useProjectStore((s) => s.openProject);
  const navigate = useNavigate();

  const [selected, setSelected] = useState<Format>('9:16');
  const [fps, setFps] = useState(30);
  const defaultName = `Untitled · ${new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  const [name, setName] = useState(defaultName);
  const [customW, setCustomW] = useState(1080);
  const [customH, setCustomH] = useState(1920);
  const [showCustom, setShowCustom] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    setBusy(true);
    try {
      const fmt = FORMATS.find((f) => f.id === selected);
      const width = selected === 'custom' ? customW : fmt?.width ?? 1080;
      const height = selected === 'custom' ? customH : fmt?.height ?? 1920;
      const project = await createProject({
        name: name.trim() || 'Untitled project',
        format: selected,
        width,
        height,
        fps,
      });
      await openProject(project.id);
      close();
      navigate(`/editor/${project.id}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} width={720}>
      <div style={{ padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div className="display" style={{ fontSize: 28, letterSpacing: '0.04em' }}>
            Choose your format
          </div>
          <button className="sn-icon-btn" onClick={close} aria-label="Close">
            <Icons.X size={14} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
          {FORMATS.map((f) => {
            const active = selected === f.id;
            return (
              <button
                key={f.id}
                onClick={() => setSelected(f.id)}
                style={{
                  padding: 18,
                  borderRadius: 12,
                  border: `1.5px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                  background: active ? 'rgba(200,242,58,0.06)' : 'var(--bg-base)',
                  boxShadow: active ? '0 0 24px rgba(200,242,58,0.25)' : 'none',
                  opacity: selected === 'custom' ? 1 : active ? 1 : 0.5,
                  textAlign: 'left',
                  transition: 'all .15s',
                }}
              >
                <div style={{ height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
                  <f.Icon size={64} stroke={active ? 'var(--accent-primary)' : 'var(--text-secondary)'} sw={1.2} />
                </div>
                <div className="display" style={{ fontSize: 28, lineHeight: 1, color: active ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                  {f.ratio}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{f.label} · {f.size}</div>
                {f.tag && (
                  <div
                    style={{
                      display: 'inline-block',
                      marginTop: 8,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: 'rgba(200,242,58,0.1)',
                      color: 'var(--accent-primary)',
                      fontSize: 9.5,
                      fontWeight: 700,
                      letterSpacing: 0.4,
                    }}
                  >
                    {f.tag}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        <button
          onClick={() => {
            setShowCustom(!showCustom);
            if (!showCustom) setSelected('custom');
          }}
          style={{
            marginTop: 18,
            color: 'var(--accent-primary)',
            fontSize: 12,
            fontWeight: 600,
            background: 'transparent',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {showCustom ? '−' : '+'} Custom size
        </button>
        {showCustom && (
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <Input type="number" value={customW} onChange={(e) => setCustomW(parseInt(e.target.value))} />
            <span style={{ alignSelf: 'center', color: 'var(--text-secondary)' }}>×</span>
            <Input type="number" value={customH} onChange={(e) => setCustomH(parseInt(e.target.value))} />
          </div>
        )}

        <div style={{ marginTop: 22 }}>
          <div className="sn-section-label" style={{ marginBottom: 8 }}>FPS</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {FPS_OPTIONS.map((f) => (
              <button
                key={f}
                onClick={() => setFps(f)}
                style={{
                  padding: '7px 14px',
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 600,
                  border: `1px solid ${fps === f ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                  background: fps === f ? 'rgba(200,242,58,0.1)' : 'var(--bg-base)',
                  color: fps === f ? 'var(--accent-primary)' : 'var(--text-primary)',
                }}
              >
                {f}fps
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 22 }}>
          <div className="sn-section-label" style={{ marginBottom: 8 }}>Project name</div>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <Button
          variant="primary"
          onClick={handleCreate}
          disabled={busy}
          style={{ width: '100%', justifyContent: 'center', marginTop: 24, padding: '12px 14px', fontSize: 13 }}
        >
          Create project <Icons.Arrow size={13} stroke="#0A0A0C" />
        </Button>
      </div>
    </Modal>
  );
}
