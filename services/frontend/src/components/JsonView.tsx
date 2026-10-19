import React, { useState } from 'react';

interface JsonViewProps {
  data: unknown;
  initialExpanded?: boolean;
  className?: string;
}

export const JsonView: React.FC<JsonViewProps> = ({
  data,
  initialExpanded = false,
  className = ''
}) => {
  const [expanded, setExpanded] = useState(initialExpanded);

  const formatted = JSON.stringify(data, null, 2);

  return (
    <div
      className={`font-mono text-xs rounded-md border border-border bg-surface overflow-hidden ${className}`}
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-bg/50">
        <span className="text-text-muted font-medium">JSON Payload</span>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-primary font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs px-1 cursor-pointer"
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      <div className={`p-3 overflow-x-auto ${expanded ? 'max-h-96' : 'max-h-24'} transition-all`}>
        <pre className="text-text whitespace-pre-wrap break-all leading-relaxed">{formatted}</pre>
      </div>
    </div>
  );
};
