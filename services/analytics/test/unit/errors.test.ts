import { describe, it, expect } from 'vitest';
import { AppError, formatProblemDetails } from '../../src/errors.js';

describe('Analytics Errors', () => {
  it('formats problem details with all optional fields', () => {
    const err = new AppError({
      message: 'test error',
      statusCode: 400,
      code: 'BAD_REQUEST',
      type: 'https://example.com/err',
      errors: [{ field: 'field1', message: 'is required' }]
    });

    expect(err.statusCode).toBe(400);

    const problem = formatProblemDetails({
      title: 'Bad Request',
      status: 400,
      code: 'BAD_REQUEST',
      correlationId: 'corr-1',
      detail: 'Detail message',
      instance: '/api/v1/analytics/test',
      type: 'https://example.com/err',
      errors: [{ field: 'field1', message: 'is required' }]
    });

    expect(problem.instance).toBe('/api/v1/analytics/test');
    expect(problem.errors).toHaveLength(1);
  });

  it('formats problem details with minimal fields', () => {
    const problem = formatProblemDetails({
      title: 'Internal Server Error',
      status: 500,
      code: 'INTERNAL_ERROR',
      correlationId: 'corr-2'
    });

    expect(problem.status).toBe(500);
    expect(problem.detail).toBeUndefined();
    expect(problem.instance).toBeUndefined();
  });
});
