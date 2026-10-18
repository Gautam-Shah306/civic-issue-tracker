import React from 'react';
import { ReportStatus } from '../api/types.js';
import { Badge, BadgeVariant } from './Badge.js';

export interface StatusBadgeProps {
  status: ReportStatus;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, className = '' }) => {
  let variant: BadgeVariant = 'neutral';
  let icon: React.ReactNode = null;

  switch (status) {
    case 'Submitted':
      variant = 'neutral';
      icon = (
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="8" r="4" />
        </svg>
      );
      break;
    case 'Verified':
      variant = 'info';
      icon = (
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M12.7 4.3a1 1 0 0 0-1.4 0L7 8.6 4.7 6.3a1 1 0 0 0-1.4 1.4l3 3a1 1 0 0 0 1.4 0l5-5a1 1 0 0 0 0-1.4z" />
        </svg>
      );
      break;
    case 'Assigned':
      variant = 'info';
      icon = (
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-5 6a5 5 0 0 1 10 0H3z" />
        </svg>
      );
      break;
    case 'In Progress':
      variant = 'warning';
      icon = (
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 2a6 6 0 1 0 6 6A6 6 0 0 0 8 2zm1 6.4V5H7v4.4l3 2.1 1.1-1.6z" />
        </svg>
      );
      break;
    case 'Resolved':
      variant = 'success';
      icon = (
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M13.8 4.2a1 1 0 0 0-1.4 0L6.5 10 3.6 7.2a1 1 0 1 0-1.4 1.4l3.6 3.6a1 1 0 0 0 1.4 0l6.6-6.6a1 1 0 0 0 0-1.4z" />
        </svg>
      );
      break;
    case 'Closed':
      variant = 'neutral';
      icon = (
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 1a7 7 0 1 0 7 7A7 7 0 0 0 8 1zm0 12.5A5.5 5.5 0 1 1 13.5 8 5.5 5.5 0 0 1 8 13.5z" />
        </svg>
      );
      break;
    case 'Rejected':
      variant = 'danger';
      icon = (
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M4.6 4.6a1 1 0 0 1 1.4 0L8 6.6l2-2a1 1 0 1 1 1.4 1.4L9.4 8l2 2a1 1 0 0 1-1.4 1.4L8 9.4l-2 2a1 1 0 0 1-1.4-1.4L6.6 8l-2-2a1 1 0 0 1 0-1.4z" />
        </svg>
      );
      break;
    case 'Reopened':
      variant = 'warning';
      icon = (
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 2.5a5.5 5.5 0 1 0 5.3 4H15a7 7 0 1 1-1.8-4.5L15 4V0h-4l1.6 1.6A6.9 6.9 0 0 0 8 2.5z" />
        </svg>
      );
      break;
  }

  return (
    <Badge variant={variant} className={className}>
      {icon}
      <span>{status}</span>
    </Badge>
  );
};
