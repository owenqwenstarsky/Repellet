import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  busy?: boolean;
};
// Children stay a direct text node of <button> so tests can read getByText(label).disabled.
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  busy = false,
  className = '',
  type = 'button',
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`button ${variant} ${size === 'sm' ? 'small' : ''} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Loader2 size={size === 'sm' ? 13 : 15} className="spin" /> : icon}
      {children}
    </button>
  );
}
export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  label: string;
  icon: ReactNode;
  size?: 'sm' | 'md';
  pressed?: boolean;
};
export function IconButton({
  label,
  icon,
  size = 'md',
  pressed,
  className = '',
  type = 'button',
  title,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      className={`icon-button ${size === 'sm' ? 'small' : ''} ${className}`}
      {...rest}
    >
      {icon}
    </button>
  );
}
