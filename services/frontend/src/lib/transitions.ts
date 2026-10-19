import type { ReportStatus, UserRole } from '../api/types';

export interface TransitionRule {
  from: ReportStatus;
  to: ReportStatus;
  roles: UserRole[];
  requiresOwner?: boolean;
}

export const TRANSITION_RULES: TransitionRule[] = [
  // From Submitted
  { from: 'Submitted', to: 'Verified', roles: ['officer', 'admin'] },
  { from: 'Submitted', to: 'Assigned', roles: ['admin'] },
  { from: 'Submitted', to: 'Rejected', roles: ['officer', 'admin'] },

  // From Verified
  { from: 'Verified', to: 'Assigned', roles: ['admin'] },
  { from: 'Verified', to: 'Rejected', roles: ['officer', 'admin'] },

  // From Assigned
  { from: 'Assigned', to: 'In Progress', roles: ['officer', 'admin'] },
  { from: 'Assigned', to: 'Rejected', roles: ['officer', 'admin'] },

  // From In Progress
  { from: 'In Progress', to: 'Resolved', roles: ['officer', 'admin'] },

  // From Resolved
  { from: 'Resolved', to: 'Closed', roles: ['admin'] },
  { from: 'Resolved', to: 'Reopened', roles: ['citizen'], requiresOwner: true },
  { from: 'Resolved', to: 'Reopened', roles: ['admin'] },

  // From Closed
  { from: 'Closed', to: 'Reopened', roles: ['citizen'], requiresOwner: true },
  { from: 'Closed', to: 'Reopened', roles: ['admin'] },

  // From Reopened
  { from: 'Reopened', to: 'Assigned', roles: ['admin'] },
  { from: 'Reopened', to: 'In Progress', roles: ['officer', 'admin'] }
];

export const REJECTION_REASONS = [
  { value: 'duplicate', label: 'Duplicate report' },
  { value: 'invalid', label: 'Invalid / Not actionable' },
  { value: 'out_of_jurisdiction', label: 'Out of municipal jurisdiction' }
] as const;

export type RejectionReasonCode = (typeof REJECTION_REASONS)[number]['value'];

/**
 * Returns the list of valid target statuses for a report given the current status, user role,
 * and whether the user is the owner of the report.
 */
export function getAllowedTransitions(
  currentStatus: ReportStatus,
  role: UserRole | undefined,
  isOwnReport = false
): ReportStatus[] {
  if (!role) return [];

  return TRANSITION_RULES.filter((rule) => {
    if (rule.from !== currentStatus) return false;
    if (!rule.roles.includes(role)) return false;
    if (rule.requiresOwner && !isOwnReport) return false;
    return true;
  }).map((rule) => rule.to);
}

/**
 * Checks whether transitioning to targetStatus requires a mandatory reason code.
 */
export function requiresReason(targetStatus: ReportStatus): boolean {
  return targetStatus === 'Rejected';
}
