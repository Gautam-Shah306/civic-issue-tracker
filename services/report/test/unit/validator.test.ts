import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createEventValidator } from '../../src/events/validator.js';
import { Config } from '../../src/config.js';

describe('Event Validator (report.submitted and report.status-changed)', () => {
  const dummyConfig: Config = {
    SERVICE_NAME: 'report',
    PORT: 3000,
    LOG_LEVEL: 'silent',
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    DB_NAME: 'civic_report',
    DB_USER: 'civic_report',
    DB_PASSWORD: '',
    RABBITMQ_URL: '',
    JWT_PUBLIC_KEY_B64: 'dummy',
    JWT_ISSUER: 'civic-auth',
    JWT_AUDIENCE: 'civic-api',
    OUTBOX_INTERVAL_MS: 500,
    CONTRACTS_DIR: '../../contracts'
  };

  const validator = createEventValidator(dummyConfig);

  it('validates a correct report.submitted event envelope and payload', () => {
    const validSubmitted = {
      eventId: randomUUID(),
      eventType: 'report.submitted',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      payload: {
        reportId: randomUUID(),
        reporterId: randomUUID(),
        title: 'Broken streetlight on Main St',
        description: 'Light has been flickering and completely dark for 3 days',
        category: 'streetlight',
        location: {
          lat: 23.0225,
          lng: 72.5714,
          address: 'Main Street, Ward 4'
        },
        submittedAt: new Date().toISOString()
      }
    };

    expect(() => validator.validateEvent('report.submitted', validSubmitted)).not.toThrow();
  });

  it('validates a correct report.status-changed event envelope and payload', () => {
    const validStatusChanged = {
      eventId: randomUUID(),
      eventType: 'report.status-changed',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      payload: {
        reportId: randomUUID(),
        fromStatus: 'Submitted',
        toStatus: 'Verified',
        changedBy: randomUUID(),
        changedAt: new Date().toISOString(),
        note: 'Verified by field officer on site'
      }
    };

    expect(() =>
      validator.validateEvent('report.status-changed', validStatusChanged)
    ).not.toThrow();
  });

  it('rejects an event with invalid coordinates in report.submitted', () => {
    const invalidCoords = {
      eventId: randomUUID(),
      eventType: 'report.submitted',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      payload: {
        reportId: randomUUID(),
        reporterId: randomUUID(),
        title: 'Pothole',
        description: 'Large hole in road',
        category: 'pothole',
        location: {
          lat: 105.0, // Invalid latitude (> 90)
          lng: 72.0
        },
        submittedAt: new Date().toISOString()
      }
    };

    expect(() => validator.validateEvent('report.submitted', invalidCoords)).toThrow(
      /Event validation failed/
    );
  });

  it('rejects an event with missing envelope fields', () => {
    const missingEnvelope = {
      eventType: 'report.status-changed',
      version: 1,
      payload: {
        reportId: randomUUID(),
        fromStatus: 'Submitted',
        toStatus: 'Verified',
        changedBy: randomUUID(),
        changedAt: new Date().toISOString()
      }
    };

    expect(() => validator.validateEvent('report.status-changed', missingEnvelope)).toThrow(
      /Event validation failed/
    );
  });
});
