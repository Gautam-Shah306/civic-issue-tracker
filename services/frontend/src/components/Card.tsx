import React from 'react';

export interface CardProps {
  children: React.ReactNode;
  className?: string;
  surface?: boolean;
}

export const Card: React.FC<CardProps> = ({ children, className = '', surface = false }) => {
  const bgClass = surface ? 'bg-surface' : 'bg-bg';

  return (
    <div className={`rounded-lg border border-border ${bgClass} p-4 sm:p-6 shadow-sm ${className}`}>
      {children}
    </div>
  );
};
