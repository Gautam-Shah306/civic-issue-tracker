import React from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  id: string;
  label: string;
  options: SelectOption[];
  error?: string;
  hint?: string;
  controlSize?: 'sm' | 'md' | 'lg';
}

export const Select: React.FC<SelectProps> = ({
  id,
  label,
  options,
  error,
  hint,
  controlSize = 'md',
  className = '',
  ...props
}) => {
  const errorId = error ? `${id}-error` : undefined;
  const hintId = hint ? `${id}-hint` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  const heightClass =
    controlSize === 'sm'
      ? 'h-control-sm text-xs'
      : controlSize === 'lg'
        ? 'h-control-lg text-lg'
        : 'h-control text-sm';

  const borderClass = error ? 'border border-danger-text' : 'border border-border';

  return (
    <div className="flex flex-col gap-1 w-full">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      {hint && (
        <span id={hintId} className="text-xs text-text-muted">
          {hint}
        </span>
      )}
      <select
        id={id}
        aria-describedby={describedBy}
        aria-invalid={error ? 'true' : 'false'}
        className={`w-full px-3 bg-bg text-text rounded-md focus-ring ${heightClass} ${borderClass} ${className}`}
        {...props}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && (
        <span id={errorId} role="alert" className="text-xs text-danger-text font-medium">
          {error}
        </span>
      )}
    </div>
  );
};
