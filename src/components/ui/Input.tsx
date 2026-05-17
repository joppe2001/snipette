import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export function Input({ invalid, className = '', style, ...rest }: InputProps): JSX.Element {
  return (
    <input
      {...rest}
      className={className}
      style={{
        background: 'var(--bg-base)',
        borderRadius: 6,
        padding: '7px 10px',
        border: `1px solid ${invalid ? 'var(--red-alert)' : 'var(--border-subtle)'}`,
        fontSize: 12,
        color: 'var(--text-primary)',
        outline: 'none',
        width: '100%',
        ...style,
      }}
    />
  );
}

interface NumProps {
  value: number | string;
  suffix?: string;
  muted?: boolean;
  onChange?: (v: number) => void;
}

export function NumInput({ value, suffix, muted, onChange }: NumProps): JSX.Element {
  return (
    <div
      style={{
        background: 'var(--bg-base)',
        borderRadius: 6,
        border: '1px solid var(--border-subtle)',
        padding: '6px 8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 11,
        color: muted ? 'var(--text-secondary)' : 'var(--text-primary)',
        minWidth: 0,
      }}
    >
      <input
        type="number"
        value={value}
        onChange={(e) => onChange?.(parseFloat(e.target.value))}
        readOnly={!onChange}
        className="mono"
        style={{ width: '100%', background: 'transparent', fontSize: 11 }}
      />
      {suffix && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{suffix}</span>}
    </div>
  );
}
