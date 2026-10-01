import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
type ControlProps = {
  id?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
};
// Labels a single control and wires its help and error text for assistive technology.
export function Field({
  id,
  label,
  help,
  error,
  optional = false,
  className = '',
  children,
}: {
  id?: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string;
  optional?: boolean;
  className?: string;
  children: ReactElement<ControlProps>;
}) {
  const generated = useId();
  const base = id || generated;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: children.props.id || base,
        'aria-invalid': error ? true : children.props['aria-invalid'],
        'aria-describedby':
          [children.props['aria-describedby'], help && `${base}-help`, error && `${base}-error`]
            .filter(Boolean)
            .join(' ') || undefined,
      })
    : children;
  return (
    <div className={`field ${className}`}>
      <div className="field-label">
        <label htmlFor={children.props.id || base}>{label}</label>
        {optional && <span className="optional">Optional</span>}
      </div>
      {control}
      {help && (
        <p className="field-help" id={`${base}-help`}>
          {help}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert" id={`${base}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
export function FormRow({ children, columns = 2 }: { children: ReactNode; columns?: 2 | 3 }) {
  return <div className={`form-row columns-${columns}`}>{children}</div>;
}
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p className="form-error" role="alert">
      {children}
    </p>
  );
}
