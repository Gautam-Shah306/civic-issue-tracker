import React from 'react';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  className?: string;
  sortable?: boolean;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (row: T) => string;
  emptyMessage?: string;
  isLoading?: boolean;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  className?: string;
}

export function DataTable<T>({
  columns,
  data,
  keyExtractor,
  emptyMessage = 'No records found',
  isLoading = false,
  sortBy,
  sortOrder,
  onSort,
  className = ''
}: DataTableProps<T>): React.ReactElement {
  if (isLoading) {
    return (
      <div className="p-8 text-center text-sm text-text-muted bg-bg rounded-lg border border-border">
        Loading data...
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-text-muted bg-bg rounded-lg border border-border">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={`overflow-x-auto rounded-lg border border-border bg-bg ${className}`}>
      <table className="w-full text-left border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-surface text-text font-semibold text-xs uppercase tracking-wider">
            {columns.map((col) => {
              const isSorted = sortBy === col.key;
              return (
                <th key={col.key} scope="col" className={`px-4 py-3 ${col.className || ''}`}>
                  {col.sortable && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(col.key)}
                      className="inline-flex items-center gap-1 font-semibold uppercase hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs cursor-pointer"
                    >
                      <span>{col.header}</span>
                      <span aria-hidden="true" className="text-xs">
                        {isSorted ? (sortOrder === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {data.map((row) => (
            <tr key={keyExtractor(row)} className="hover:bg-surface/50 transition-colors">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-4 py-3 text-text align-middle ${col.className || ''}`}
                >
                  {col.render
                    ? col.render(row)
                    : ((row as Record<string, unknown>)[col.key] as React.ReactNode)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
