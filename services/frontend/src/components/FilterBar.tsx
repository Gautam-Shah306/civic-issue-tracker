import React from 'react';
import { Button } from './Button';

interface FilterBarProps {
  onClear?: () => void;
  hasActiveFilters?: boolean;
  children: React.ReactNode;
  className?: string;
}

export const FilterBar: React.FC<FilterBarProps> = ({
  onClear,
  hasActiveFilters = false,
  children,
  className = ''
}) => {
  return (
    <div
      role="search"
      aria-label="Filter records"
      className={`p-4 bg-surface rounded-lg border border-border flex flex-col gap-3 ${className}`}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
        {children}
      </div>

      {hasActiveFilters && onClear && (
        <div className="flex items-center justify-end pt-2 border-t border-border/50">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="text-xs text-text-muted hover:text-danger-text"
          >
            Clear all filters
          </Button>
        </div>
      )}
    </div>
  );
};
