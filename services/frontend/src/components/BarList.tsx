import React from 'react';

export interface BarListItem {
  label: string;
  value: number;
  colorClass?: string;
  badge?: string;
}

interface BarListProps {
  items: BarListItem[];
  emptyMessage?: string;
  className?: string;
}

export const BarList: React.FC<BarListProps> = ({
  items,
  emptyMessage = 'No data available',
  className = ''
}) => {
  if (items.length === 0) {
    return (
      <div
        className={`p-4 text-center text-sm text-text-muted bg-surface rounded-md border border-border ${className}`}
      >
        {emptyMessage}
      </div>
    );
  }

  const maxValue = Math.max(...items.map((item) => item.value ?? 0), 1);

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {items.map((item) => {
        const val = item.value ?? 0;
        const percentage = Math.round((val / maxValue) * 100);
        return (
          <div key={item.label} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs font-medium text-text">
              <span className="truncate pr-2">{item.label}</span>
              <span className="font-semibold">{val.toLocaleString()}</span>
            </div>
            <div
              className="h-2 w-full bg-surface rounded-sm overflow-hidden border border-border/50"
              role="progressbar"
              aria-valuenow={val}
              aria-valuemin={0}
              aria-valuemax={maxValue}
              aria-label={`${item.label}: ${val}`}
            >
              <div
                className={`h-full transition-all duration-500 rounded-sm ${
                  item.colorClass || 'bg-primary'
                }`}
                style={{ width: `${percentage}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};
