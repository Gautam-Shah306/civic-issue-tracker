// src/domain/transitions.ts
// Report status lifecycle state machine (docs/03 section 5, D-040)

export const REPORT_STATUSES = [
  'Submitted',
  'Verified',
  'Assigned',
  'In Progress',
  'Resolved',
  'Closed',
  'Rejected',
  'Reopened'
] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

export type UserRole = 'citizen' | 'officer' | 'admin' | 'system';

export const REJECTION_REASON_CODES = ['duplicate', 'invalid', 'out_of_jurisdiction'] as const;

export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];

export interface TransitionRule {
  from: ReportStatus | null;
  to: ReportStatus;
  allowedRoles: UserRole[];
  requiresOwner?: boolean;
  requiresReasonCode?: boolean;
}

// Status transition table from docs/03 section 5 (D-040)
export const STATUS_TRANSITIONS_DATA: readonly TransitionRule[] = [
  { from: null, to: 'Submitted', allowedRoles: ['citizen', 'officer', 'admin'] },
  { from: 'Submitted', to: 'Verified', allowedRoles: ['officer', 'admin'] },
  { from: 'Submitted', to: 'Assigned', allowedRoles: ['admin', 'system'] },
  {
    from: 'Submitted',
    to: 'Rejected',
    allowedRoles: ['officer', 'admin'],
    requiresReasonCode: true
  },
  { from: 'Verified', to: 'Assigned', allowedRoles: ['admin', 'system'] },
  {
    from: 'Verified',
    to: 'Rejected',
    allowedRoles: ['officer', 'admin'],
    requiresReasonCode: true
  },
  { from: 'Assigned', to: 'In Progress', allowedRoles: ['officer', 'admin'] },
  {
    from: 'Assigned',
    to: 'Rejected',
    allowedRoles: ['officer', 'admin'],
    requiresReasonCode: true
  },
  { from: 'In Progress', to: 'Resolved', allowedRoles: ['officer', 'admin'] },
  { from: 'Resolved', to: 'Closed', allowedRoles: ['admin', 'system'] },
  { from: 'Resolved', to: 'Reopened', allowedRoles: ['citizen', 'admin'], requiresOwner: true },
  { from: 'Closed', to: 'Reopened', allowedRoles: ['citizen', 'admin'], requiresOwner: true },
  { from: 'Reopened', to: 'Assigned', allowedRoles: ['admin', 'system'] },
  { from: 'Reopened', to: 'In Progress', allowedRoles: ['officer', 'admin'] }
] as const;

export interface TransitionValidationResult {
  valid: boolean;
  errorCode?:
    'invalid_transition' | 'forbidden_role' | 'missing_reason_code' | 'invalid_reason_code';
  message?: string;
}

/**
 * Pure function that validates whether a status transition is permitted.
 */
export function validateStatusTransition(options: {
  from: ReportStatus | null;
  to: ReportStatus;
  role: UserRole;
  isOwner?: boolean;
  reasonCode?: string | null;
}): TransitionValidationResult {
  const { from, to, role, isOwner, reasonCode } = options;

  // Rejected is terminal: no further transitions permitted
  if (from === 'Rejected') {
    return {
      valid: false,
      errorCode: 'invalid_transition',
      message: 'Rejected status is terminal; no transitions are permitted from Rejected'
    };
  }

  // Find transition in DATA table
  const matchingRule = STATUS_TRANSITIONS_DATA.find((rule) => rule.from === from && rule.to === to);

  if (!matchingRule) {
    return {
      valid: false,
      errorCode: 'invalid_transition',
      message: `Transition from ${from ?? '(new)'} to ${to} is not allowed`
    };
  }

  // Check allowed role
  if (!matchingRule.allowedRoles.includes(role)) {
    return {
      valid: false,
      errorCode: 'forbidden_role',
      message: `Role ${role} is not permitted to transition from ${from ?? '(new)'} to ${to}`
    };
  }

  // Ownership rule: citizens can only reopen their own reports
  if (role === 'citizen' && matchingRule.requiresOwner && !isOwner) {
    return {
      valid: false,
      errorCode: 'forbidden_role',
      message: 'Citizens can only reopen their own reports'
    };
  }

  // Rejection requires a valid reason code (STS-07)
  if (matchingRule.requiresReasonCode) {
    if (!reasonCode || reasonCode.trim() === '') {
      return {
        valid: false,
        errorCode: 'missing_reason_code',
        message: 'Rejection requires a reason code (duplicate, invalid, out_of_jurisdiction)'
      };
    }
    if (!REJECTION_REASON_CODES.includes(reasonCode as RejectionReasonCode)) {
      return {
        valid: false,
        errorCode: 'invalid_reason_code',
        message: `Invalid rejection reason code: ${reasonCode}. Allowed: ${REJECTION_REASON_CODES.join(', ')}`
      };
    }
  }

  return { valid: true };
}
