import React from 'react';
import { Select } from './Select';
import { REJECTION_REASONS, RejectionReasonCode } from '../lib/transitions';

interface ReasonSelectProps {
  id?: string;
  value: string;
  onChange: (value: RejectionReasonCode) => void;
  error?: string;
  hint?: string;
}

export const ReasonSelect: React.FC<ReasonSelectProps> = ({
  id = 'rejection-reason',
  value,
  onChange,
  error,
  hint = 'Mandatory justification for rejecting this report'
}) => {
  const options = [{ value: '', label: '-- Select a rejection reason --' }, ...REJECTION_REASONS];

  return (
    <Select
      id={id}
      label="Rejection Reason"
      options={options}
      value={value}
      onChange={(e) => onChange(e.target.value as RejectionReasonCode)}
      error={error}
      hint={hint}
      required
    />
  );
};
