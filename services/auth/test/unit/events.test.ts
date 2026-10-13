import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createEventValidator } from '../../src/events/validator.js';
import { Config } from '../../src/config.js';

describe('Event Validation (user.created.v1)', () => {
  const dummyConfig: Config = {
    SERVICE_NAME: 'auth',
    PORT: 3000,
    LOG_LEVEL: 'silent',
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    DB_NAME: 'civic_auth',
    DB_USER: 'civic_auth',
    DB_PASSWORD: '',
    RABBITMQ_URL: '',
    JWT_PRIVATE_KEY_B64: 'dummy',
    JWT_ISSUER: 'civic-auth',
    JWT_AUDIENCE: 'civic-api',
    ACCESS_TTL_SECONDS: 900,
    REFRESH_TTL_DAYS: 7,
    ARGON2_MEMORY_KIB: 19456,
    ARGON2_ITERATIONS: 2,
    ARGON2_PARALLELISM: 1,
    OUTBOX_INTERVAL_MS: 500,
    CONTRACTS_DIR: '../../contracts'
  };

  const validator = createEventValidator(dummyConfig);

  it('validates a correct user.created event envelope and payload', () => {
    const validEvent = {
      eventId: randomUUID(),
      eventType: 'user.created',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      payload: {
        userId: randomUUID(),
        email: 'citizen@example.com',
        displayName: 'Jane Doe',
        role: 'citizen',
        createdAt: new Date().toISOString()
      }
    };

    expect(() => validator.validateUserCreated(validEvent)).not.toThrow();
  });

  it('rejects an event with missing envelope fields', () => {
    const missingEnvelope = {
      eventType: 'user.created',
      version: 1,
      payload: {
        userId: randomUUID(),
        email: 'citizen@example.com',
        displayName: 'Jane Doe',
        role: 'citizen',
        createdAt: new Date().toISOString()
      }
    };

    expect(() => validator.validateUserCreated(missingEnvelope)).toThrow();
  });

  it('rejects an event with invalid role or bad email in payload', () => {
    const badRole = {
      eventId: randomUUID(),
      eventType: 'user.created',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      payload: {
        userId: randomUUID(),
        email: 'not-an-email',
        displayName: 'Jane Doe',
        role: 'superuser', // invalid role enum
        createdAt: new Date().toISOString()
      }
    };

    expect(() => validator.validateUserCreated(badRole)).toThrow();
  });
});
