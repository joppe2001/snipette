import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useEditorStore } from '@/store/editor.store';
import { useSettingsStore } from '@/store/settings.store';
import { Toggle } from '@/components/ui/Toggle';
import { Slider } from '@/components/ui/Slider';
import { Icons } from '@/components/ui/icons';
import { fileSizeLabel } from '@/utils/file';
import { BackupModal } from './BackupModal';

const CATEGORIES = [
  'General',
  'Performance',
  'Storage',
  'Appearance',
  'Shortcuts',
  'Backup',
  'About',
] as const;
type Category = (typeof CATEGORIES)[number];

export function SettingsModal(): JSX.Element {
  const open = useEditorStore((s) => s.settingsOpen);
  const close = useEditorStore((s) => s.closeSettings);
  const settings = useSettingsStore();
  const [category, setCategory] = useState<Category>('General');
  const [cacheBytes, setCacheBytes] = useState(0);
  const [appInfo, setAppInfo] = useState<{ version: string; user_data_path: string; platform: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    void settings.load();
    void window.snipette.system.getCacheSize().then(setCacheBytes);
    void window.snipette.system.appInfo().then(setAppInfo);
  }, [open]);

  const v = settings.values;

  return (
    <Modal open={open} onClose={close} width={820}>
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', minHeight: 460 }}>
        <div style={{ borderRight: '1px solid var(--border-subtle)', padding: '20px 12px' }}>
          <div className="display" style={{ fontSize: 16, marginBottom: 16, letterSpacing: '0.06em' }}>Settings</div>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '7px 10px',
                fontSize: 12,
                borderRadius: 6,
                fontWeight: category === c ? 600 : 500,
                background: category === c ? 'var(--bg-hover)' : 'transparent',
                color: category === c ? 'var(--accent-primary)' : 'var(--text-primary)',
                marginBottom: 2,
              }}
            >
              {c}
            </button>
          ))}
        </div>
        <div style={{ padding: 28, overflow: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
            <div className="display" style={{ fontSize: 20, letterSpacing: '0.06em' }}>{category}</div>
            <button className="sn-icon-btn" onClick={close}><Icons.X size={14} /></button>
          </div>

          {category === 'General' && (
            <>
              <Row label="Autosave every">
                <select value={v.autosave_interval_seconds ?? '15'} onChange={(e) => settings.set('autosave_interval_seconds', e.target.value)} style={selectStyle}>
                  <option value="5">5 seconds</option>
                  <option value="15">15 seconds</option>
                  <option value="30">30 seconds</option>
                  <option value="60">1 minute</option>
                  <option value="0">Off</option>
                </select>
              </Row>
              <Row label="Check for updates" hint="Opt-in. Snipette will never phone home without permission.">
                <Toggle on={(v.check_updates ?? '0') === '1'} onChange={(on) => settings.set('check_updates', on ? '1' : '0')} />
              </Row>
              <Row label="Language">
                <select value={v.language ?? 'en'} onChange={(e) => settings.set('language', e.target.value)} style={selectStyle}>
                  <option value="en">English</option>
                  <option value="de">Deutsch</option>
                </select>
              </Row>
            </>
          )}

          {category === 'Performance' && (
            <>
              <Row label="GPU acceleration">
                <Toggle on={(v.gpu_accel ?? '1') === '1'} onChange={(on) => settings.set('gpu_accel', on ? '1' : '0')} />
              </Row>
              <Row label="Preview quality">
                <select value={v.preview_quality ?? 'auto'} onChange={(e) => settings.set('preview_quality', e.target.value)} style={selectStyle}>
                  <option value="auto">Auto</option>
                  <option value="full">Full</option>
                  <option value="proxy">Proxy</option>
                </select>
              </Row>
            </>
          )}

          {category === 'Storage' && (
            <>
              <Row label="Cache size on disk">
                <span className="mono" style={{ fontSize: 12 }}>{fileSizeLabel(cacheBytes)}</span>
              </Row>
              <Row label="Clear cache" hint="Removes thumbnails, waveforms, and temp files. Projects are untouched.">
                <button
                  className="sn-btn-ghost"
                  onClick={async () => {
                    await window.snipette.system.clearCache();
                    const size = await window.snipette.system.getCacheSize();
                    setCacheBytes(size);
                  }}
                >
                  Clear now
                </button>
              </Row>
              {appInfo && (
                <Row label="Data location">
                  <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{appInfo.user_data_path}</span>
                </Row>
              )}
            </>
          )}

          {category === 'Appearance' && (
            <>
              <Row label="Accent color" hint="Theming change requires restart">
                <input
                  type="color"
                  value={v.accent_color ?? '#C8F23A'}
                  onChange={(e) => settings.set('accent_color', e.target.value)}
                  style={{ width: 28, height: 24, background: 'transparent', border: 'none' }}
                />
              </Row>
              <Row label="UI font size">
                <Slider
                  value={parseInt(v.font_size_pct ?? '100') / 200}
                  min={0}
                  max={1}
                  onChange={(val) => settings.set('font_size_pct', String(Math.round(val * 200)))}
                />
              </Row>
              <Row label="Timeline density">
                <select value={v.timeline_density ?? 'normal'} onChange={(e) => settings.set('timeline_density', e.target.value)} style={selectStyle}>
                  <option value="compact">Compact</option>
                  <option value="normal">Normal</option>
                  <option value="expanded">Expanded</option>
                </select>
              </Row>
            </>
          )}

          {category === 'Shortcuts' && (
            <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
              Custom shortcut bindings are coming soon. Press <span className="sn-kbd">?</span> from anywhere in Snipette to see the current cheat sheet.
            </div>
          )}

          {category === 'Backup' && <BackupModal />}

          {category === 'About' && appInfo && (
            <div>
              <Row label="Version">
                <span className="mono">{appInfo.version}</span>
              </Row>
              <Row label="Platform">
                <span className="mono">{appInfo.platform}</span>
              </Row>
              <Row label="Whisper" hint="Local speech-to-text for auto-captions. Drop the binary in resources/.">
                <span className="mono" style={{ color: settings.whisperAvailable ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                  {settings.whisperAvailable ? 'Available' : 'Not installed'}
                </span>
              </Row>
              <div style={{ marginTop: 20, padding: 14, background: 'var(--bg-base)', borderRadius: 8, fontSize: 11, color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icons.Lock size={12} />
                Snipette runs entirely offline. No telemetry. No accounts. Your footage never leaves this machine.
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid var(--border-subtle)', gap: 18 }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 500 }}>{label}</div>
        {hint && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3, maxWidth: 360 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg-base)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  color: 'var(--text-primary)',
};
