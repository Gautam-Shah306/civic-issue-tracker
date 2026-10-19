import { describe, it, expect } from 'vitest';
import { getAllowedTransitions, requiresReason, REJECTION_REASONS } from '../lib/transitions';

describe('Status Transition Matrix (docs/03-architecture-and-communication.md Section 5)', () => {
  describe('Submitted state transitions', () => {
    it('allows officer to transition to Verified and Rejected', () => {
      const allowed = getAllowedTransitions('Submitted', 'officer');
      expect(allowed).toEqual(['Verified', 'Rejected']);
    });

    it('allows admin to transition to Verified, Assigned, and Rejected', () => {
      const allowed = getAllowedTransitions('Submitted', 'admin');
      expect(allowed).toEqual(['Verified', 'Assigned', 'Rejected']);
    });

    it('does not allow citizen to transition Submitted reports', () => {
      expect(getAllowedTransitions('Submitted', 'citizen', true)).toEqual([]);
      expect(getAllowedTransitions('Submitted', 'citizen', false)).toEqual([]);
    });

    it('returns empty transitions for unauthenticated users', () => {
      expect(getAllowedTransitions('Submitted', undefined)).toEqual([]);
    });
  });

  describe('Verified state transitions', () => {
    it('allows officer to transition only to Rejected', () => {
      const allowed = getAllowedTransitions('Verified', 'officer');
      expect(allowed).toEqual(['Rejected']);
    });

    it('allows admin to transition to Assigned and Rejected', () => {
      const allowed = getAllowedTransitions('Verified', 'admin');
      expect(allowed).toEqual(['Assigned', 'Rejected']);
    });

    it('does not allow citizen to transition Verified reports', () => {
      expect(getAllowedTransitions('Verified', 'citizen', true)).toEqual([]);
    });
  });

  describe('Assigned state transitions', () => {
    it('allows officer to transition to In Progress and Rejected', () => {
      const allowed = getAllowedTransitions('Assigned', 'officer');
      expect(allowed).toEqual(['In Progress', 'Rejected']);
    });

    it('allows admin to transition to In Progress and Rejected', () => {
      const allowed = getAllowedTransitions('Assigned', 'admin');
      expect(allowed).toEqual(['In Progress', 'Rejected']);
    });

    it('does not allow citizen to transition Assigned reports', () => {
      expect(getAllowedTransitions('Assigned', 'citizen', true)).toEqual([]);
    });
  });

  describe('In Progress state transitions', () => {
    it('allows officer to transition to Resolved', () => {
      const allowed = getAllowedTransitions('In Progress', 'officer');
      expect(allowed).toEqual(['Resolved']);
    });

    it('allows admin to transition to Resolved', () => {
      const allowed = getAllowedTransitions('In Progress', 'admin');
      expect(allowed).toEqual(['Resolved']);
    });

    it('does not allow citizen to transition In Progress reports', () => {
      expect(getAllowedTransitions('In Progress', 'citizen', true)).toEqual([]);
    });
  });

  describe('Resolved state transitions', () => {
    it('allows citizen to reopen their own resolved report', () => {
      const allowed = getAllowedTransitions('Resolved', 'citizen', true);
      expect(allowed).toEqual(['Reopened']);
    });

    it('does not allow citizen to reopen another citizen resolved report', () => {
      const allowed = getAllowedTransitions('Resolved', 'citizen', false);
      expect(allowed).toEqual([]);
    });

    it('does not allow officer to transition Resolved reports', () => {
      expect(getAllowedTransitions('Resolved', 'officer')).toEqual([]);
    });

    it('allows admin to close or reopen Resolved reports', () => {
      const allowed = getAllowedTransitions('Resolved', 'admin');
      expect(allowed).toEqual(['Closed', 'Reopened']);
    });
  });

  describe('Closed state transitions', () => {
    it('allows citizen to reopen their own closed report', () => {
      const allowed = getAllowedTransitions('Closed', 'citizen', true);
      expect(allowed).toEqual(['Reopened']);
    });

    it('does not allow citizen to reopen another citizen closed report', () => {
      const allowed = getAllowedTransitions('Closed', 'citizen', false);
      expect(allowed).toEqual([]);
    });

    it('does not allow officer to reopen Closed reports', () => {
      expect(getAllowedTransitions('Closed', 'officer')).toEqual([]);
    });

    it('allows admin to reopen Closed reports', () => {
      const allowed = getAllowedTransitions('Closed', 'admin');
      expect(allowed).toEqual(['Reopened']);
    });
  });

  describe('Reopened state transitions', () => {
    it('allows officer to transition to In Progress', () => {
      const allowed = getAllowedTransitions('Reopened', 'officer');
      expect(allowed).toEqual(['In Progress']);
    });

    it('allows admin to transition to Assigned and In Progress', () => {
      const allowed = getAllowedTransitions('Reopened', 'admin');
      expect(allowed).toEqual(['Assigned', 'In Progress']);
    });

    it('does not allow citizen to transition Reopened reports', () => {
      expect(getAllowedTransitions('Reopened', 'citizen', true)).toEqual([]);
    });
  });

  describe('Rejected terminal state', () => {
    it('has no outgoing transitions for any role', () => {
      expect(getAllowedTransitions('Rejected', 'citizen', true)).toEqual([]);
      expect(getAllowedTransitions('Rejected', 'officer')).toEqual([]);
      expect(getAllowedTransitions('Rejected', 'admin')).toEqual([]);
    });
  });

  describe('Reason requirements & validation rules', () => {
    it('requires a reason code only when transitioning to Rejected', () => {
      expect(requiresReason('Rejected')).toBe(true);
      expect(requiresReason('Submitted')).toBe(false);
      expect(requiresReason('Verified')).toBe(false);
      expect(requiresReason('Assigned')).toBe(false);
      expect(requiresReason('In Progress')).toBe(false);
      expect(requiresReason('Resolved')).toBe(false);
      expect(requiresReason('Closed')).toBe(false);
      expect(requiresReason('Reopened')).toBe(false);
    });

    it('defines the three standard rejection reason codes from STS-07', () => {
      const reasonValues = REJECTION_REASONS.map((r) => r.value);
      expect(reasonValues).toContain('duplicate');
      expect(reasonValues).toContain('invalid');
      expect(reasonValues).toContain('out_of_jurisdiction');
      expect(reasonValues).toHaveLength(3);
    });
  });
});
