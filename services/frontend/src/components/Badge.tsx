import React from 'react';

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({ variant = 'neutral', children, className = '' }) => {
  let colorClass = 'bg-neutral-bg text-neutral-text';
  if (variant === 'success') colorClass = 'bg-success-bg text-success-text';
  if (variant === 'warning') colorClass = 'bg-warning-bg text-warning-text';
  if (variant === 'danger') colorClass = 'bg-danger-bg text-danger-text';
  if (variant === 'info') colorClass = 'bg-info-bg text-info-text';

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs font-medium border border-transparent ${colorClass} ${className}`}
    >
      {children}
    </span>
  );
};
