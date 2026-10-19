import React from 'react';
import { Button } from './Button';

interface ConfirmPanelProps {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'primary' | 'danger';
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
  className?: string;
}

export const ConfirmPanel: React.FC<ConfirmPanelProps> = ({
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  isLoading = false,
  onConfirm,
  onCancel,
  children,
  className = ''
}) => {
  return (
    <div
      role="region"
      aria-label={title}
      className={`p-4 rounded-lg border border-border bg-surface flex flex-col gap-3 ${className}`}
    >
      <div>
        <h4 className="text-sm font-semibold text-text">{title}</h4>
        {description && <p className="text-xs text-text-muted mt-1">{description}</p>}
      </div>

      {children && <div className="flex flex-col gap-2">{children}</div>}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={isLoading}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={confirmVariant}
          size="sm"
          onClick={onConfirm}
          loading={isLoading}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
};
