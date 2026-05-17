interface Props {
  on: boolean;
  onChange: (on: boolean) => void;
  ariaLabel?: string;
}

export function Toggle({ on, onChange, ariaLabel }: Props): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange(!on)}
      style={{
        width: 30,
        height: 16,
        borderRadius: 999,
        background: on ? 'var(--accent-primary)' : 'var(--bg-elevated)',
        position: 'relative',
        border: '1px solid var(--border-subtle)',
        transition: 'background .15s',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 1,
          left: on ? 14 : 1,
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: on ? '#0A0A0C' : 'var(--text-secondary)',
          transition: 'left .15s',
        }}
      />
    </button>
  );
}
