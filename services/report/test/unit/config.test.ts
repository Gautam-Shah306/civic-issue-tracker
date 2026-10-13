import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('Config Validation', () => {
  it('loads valid configuration with defaults', () => {
    const config = loadConfig({
      JWT_PUBLIC_KEY_B64: 'some-dummy-b64-key'
    });

    expect(config.SERVICE_NAME).toBe('report');
    expect(config.PORT).toBe(3000);
    expect(config.DB_PORT).toBe(5432);
    expect(config.DB_NAME).toBe('civic_report');
    expect(config.DB_USER).toBe('civic_report');
    expect(config.OUTBOX_INTERVAL_MS).toBe(500);
    expect(config.JWT_ISSUER).toBe('civic-auth');
    expect(config.JWT_AUDIENCE).toBe('civic-api');
  });

  it('throws when required JWT_PUBLIC_KEY_B64 is missing', () => {
    expect(() => loadConfig({})).toThrow();
  });

  it('allows overriding parameters through environment variables', () => {
    const config = loadConfig({
      JWT_PUBLIC_KEY_B64: 'some-dummy-b64-key',
      PORT: '3005',
      DB_HOST: 'postgres-custom',
      DB_NAME: 'custom_report',
      OUTBOX_INTERVAL_MS: '250'
    });

    expect(config.PORT).toBe(3005);
    expect(config.DB_HOST).toBe('postgres-custom');
    expect(config.DB_NAME).toBe('custom_report');
    expect(config.OUTBOX_INTERVAL_MS).toBe(250);
  });
});
