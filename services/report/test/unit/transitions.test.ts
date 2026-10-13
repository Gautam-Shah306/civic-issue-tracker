import { describe, it, expect } from 'vitest';
import {
  REPORT_STATUSES,
  REJECTION_REASON_CODES,
  STATUS_TRANSITIONS_DATA,
  validateStatusTransition,
  UserRole
} from '../../src/domain/transitions.js';

describe('Report Status Transitions State Machine (D-040)', () => {
  const allRoles: UserRole[] = ['citizen', 'officer', 'admin', 'system'];

  describe('Initial submission (from null)', () => {
    it('allows initial creation (null -> Submitted) for citizen, officer, admin', () => {
      for (const role of ['citizen', 'officer', 'admin'] as UserRole[]) {
        const res = validateStatusTransition({
          from: null,
          to: 'Submitted',
          role,
          isOwner: true
        });
        expect(res.valid).toBe(true);
      }
    });

    it('rejects initial creation by system', () => {
      const res = validateStatusTransition({
        from: null,
        to: 'Submitted',
        role: 'system'
      });
      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe('forbidden_role');
    });

    it('rejects initial creation to any status other than Submitted', () => {
      for (const status of REPORT_STATUSES) {
        if (status === 'Submitted') continue;
        const res = validateStatusTransition({
          from: null,
          to: status,
          role: 'citizen'
        });
        expect(res.valid).toBe(false);
        expect(res.errorCode).toBe('invalid_transition');
      }
    });
  });

  describe('Allowed transitions (matrix)', () => {
    for (const rule of STATUS_TRANSITIONS_DATA) {
      if (rule.from === null) continue;

      it(`allows transition ${rule.from} -> ${rule.to} for allowed roles`, () => {
        for (const role of rule.allowedRoles) {
          const res = validateStatusTransition({
            from: rule.from,
            to: rule.to,
            role,
            isOwner: true,
            reasonCode: rule.requiresReasonCode ? 'duplicate' : undefined
          });
          expect(res.valid, `Expected ${rule.from} -> ${rule.to} to be valid for ${role}`).toBe(
            true
          );
        }
      });

      it(`forbids transition ${rule.from} -> ${rule.to} for unauthorized roles`, () => {
        const forbiddenRoles = allRoles.filter((r) => !rule.allowedRoles.includes(r));
        for (const role of forbiddenRoles) {
          const res = validateStatusTransition({
            from: rule.from,
            to: rule.to,
            role,
            isOwner: true,
            reasonCode: rule.requiresReasonCode ? 'duplicate' : undefined
          });
          expect(res.valid, `Expected ${rule.from} -> ${rule.to} to be forbidden for ${role}`).toBe(
            false
          );
          expect(res.errorCode).toBe('forbidden_role');
        }
      });
    }
  });

  describe('Generated forbidden pair matrix', () => {
    const allowedPairs = new Set(
      STATUS_TRANSITIONS_DATA.filter((r) => r.from !== null).map((r) => `${r.from}->${r.to}`)
    );

    for (const from of REPORT_STATUSES) {
      for (const to of REPORT_STATUSES) {
        const pairKey = `${from}->${to}`;
        if (!allowedPairs.has(pairKey)) {
          it(`forbids transition pair ${from} -> ${to}`, () => {
            for (const role of allRoles) {
              const res = validateStatusTransition({
                from,
                to,
                role,
                isOwner: true,
                reasonCode: 'duplicate'
              });
              expect(res.valid, `Pair ${from}->${to} should be invalid for ${role}`).toBe(false);
              expect(res.errorCode).toBe('invalid_transition');
            }
          });
        }
      }
    }
  });

  describe('Terminal status: Rejected', () => {
    it('never allows any transition from Rejected', () => {
      for (const to of REPORT_STATUSES) {
        for (const role of allRoles) {
          const res = validateStatusTransition({
            from: 'Rejected',
            to,
            role,
            isOwner: true
          });
          expect(res.valid).toBe(false);
          expect(res.errorCode).toBe('invalid_transition');
          expect(res.message).toMatch(/terminal/);
        }
      }
    });
  });

  describe('Rejection reason code rules (STS-07)', () => {
    it('rejects without reasonCode when transitioning to Rejected', () => {
      const res = validateStatusTransition({
        from: 'Submitted',
        to: 'Rejected',
        role: 'officer',
        reasonCode: null
      });
      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe('missing_reason_code');
    });

    it('rejects with empty string reasonCode', () => {
      const res = validateStatusTransition({
        from: 'Submitted',
        to: 'Rejected',
        role: 'officer',
        reasonCode: '   '
      });
      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe('missing_reason_code');
    });

    it('rejects with invalid reason code', () => {
      const res = validateStatusTransition({
        from: 'Submitted',
        to: 'Rejected',
        role: 'officer',
        reasonCode: 'unknown_reason'
      });
      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe('invalid_reason_code');
    });

    it('accepts all valid reason codes', () => {
      for (const code of REJECTION_REASON_CODES) {
        const res = validateStatusTransition({
          from: 'Submitted',
          to: 'Rejected',
          role: 'officer',
          reasonCode: code
        });
        expect(res.valid).toBe(true);
      }
    });
  });

  describe('Ownership rule for citizen reopen', () => {
    it('allows citizen to reopen their own report', () => {
      const res1 = validateStatusTransition({
        from: 'Resolved',
        to: 'Reopened',
        role: 'citizen',
        isOwner: true
      });
      expect(res1.valid).toBe(true);

      const res2 = validateStatusTransition({
        from: 'Closed',
        to: 'Reopened',
        role: 'citizen',
        isOwner: true
      });
      expect(res2.valid).toBe(true);
    });

    it('forbids citizen from reopening another user report', () => {
      const res1 = validateStatusTransition({
        from: 'Resolved',
        to: 'Reopened',
        role: 'citizen',
        isOwner: false
      });
      expect(res1.valid).toBe(false);
      expect(res1.errorCode).toBe('forbidden_role');

      const res2 = validateStatusTransition({
        from: 'Closed',
        to: 'Reopened',
        role: 'citizen',
        isOwner: false
      });
      expect(res2.valid).toBe(false);
      expect(res2.errorCode).toBe('forbidden_role');
    });

    it('allows admin to reopen any report regardless of ownership', () => {
      const res1 = validateStatusTransition({
        from: 'Resolved',
        to: 'Reopened',
        role: 'admin',
        isOwner: false
      });
      expect(res1.valid).toBe(true);

      const res2 = validateStatusTransition({
        from: 'Closed',
        to: 'Reopened',
        role: 'admin',
        isOwner: false
      });
      expect(res2.valid).toBe(true);
    });
  });
});
