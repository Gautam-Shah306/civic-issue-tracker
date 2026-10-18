import React from 'react';
import { Button } from './Button.js';

export interface ErrorNoticeProps {
  title?: string;
  message: string;
  correlationId?: string;
  onRetry?: () => void;
  className?: string;
}

export const ErrorNotice: React.FC<ErrorNoticeProps> = ({
  title = 'Something went wrong',
  message,
  correlationId,
  onRetry,
  className = ''
}) => {
  return (
    <div
      role="alert"
      className={`p-4 rounded-lg border border-danger-text bg-danger-bg text-danger-text flex flex-col gap-2 ${className}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="text-sm mt-1">{message}</p>
        </div>
        {onRetry && (
          <Button variant="danger" size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
      {correlationId && <span className="text-xs opacity-80">Reference ID: {correlationId}</span>}
    </div>
  );
};
