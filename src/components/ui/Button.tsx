import React from 'react';

type Variant = 'primary' | 'ghost' | 'danger' | 'icon';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  active?: boolean;
}

export function Button({ variant = 'ghost', active, className = '', ...rest }: Props): JSX.Element {
  const cls =
    variant === 'primary'
      ? 'sn-btn-primary'
      : variant === 'danger'
        ? 'sn-btn-danger'
        : variant === 'icon'
          ? `sn-icon-btn ${active ? 'active' : ''}`
          : 'sn-btn-ghost';
  return <button {...rest} className={`${cls} ${className}`.trim()} />;
}
