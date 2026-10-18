import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  children: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  className = '',
  disabled,
  children,
  ...props
}) => {
  const heightClass =
    size === 'sm'
      ? 'h-control-sm text-xs px-3'
      : size === 'lg'
        ? 'h-control-lg text-lg px-6'
        : 'h-control text-sm px-4';

  let variantClass = '';
  if (disabled) {
    variantClass = 'bg-disabled-bg text-disabled-text border border-border cursor-not-allowed';
  } else if (variant === 'primary') {
    variantClass = 'bg-primary text-primary-text hover:bg-primary-hover border border-primary';
  } else if (variant === 'secondary') {
    variantClass = 'bg-transparent text-text border border-primary hover:bg-surface';
  } else if (variant === 'danger') {
    variantClass = 'bg-danger-bg text-danger-text border border-danger-text hover:opacity-90';
  }

  return (
    <button
      disabled={disabled}
      className={`inline-flex items-center justify-center font-medium rounded-md focus-ring transition-colors ${heightClass} ${variantClass} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};
