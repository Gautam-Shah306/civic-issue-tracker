import React from 'react';

export interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  showCount?: boolean;
}

export const TextArea: React.FC<TextAreaProps> = ({
  id,
  label,
  error,
  hint,
  showCount = false,
  maxLength,
  value,
  className = '',
  ...props
}) => {
  const errorId = error ? `${id}-error` : undefined;
  const hintId = hint ? `${id}-hint` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  const currentLength = typeof value === 'string' ? value.length : 0;
  const borderClass = error ? 'border border-danger-text' : 'border border-border';

  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex justify-between items-center">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {label}
        </label>
        {showCount && maxLength && (
          <span className="text-xs text-text-muted">
            {currentLength} / {maxLength}
          </span>
        )}
      </div>
      {hint && (
        <span id={hintId} className="text-xs text-text-muted">
          {hint}
        </span>
      )}
      <textarea
        id={id}
        value={value}
        maxLength={maxLength}
        aria-describedby={describedBy}
        aria-invalid={error ? 'true' : 'false'}
        className={`w-full p-3 bg-bg text-text rounded-md focus-ring ${borderClass} ${className}`}
        rows={4}
        {...props}
      />
      {error && (
        <span id={errorId} role="alert" className="text-xs text-danger-text font-medium">
          {error}
        </span>
      )}
    </div>
  );
};
