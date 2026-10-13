import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('Config Validation', () => {
  it('loads valid configuration with defaults', () => {
    const config = loadConfig({
      JWT_PRIVATE_KEY_B64: 'some-dummy-b64-key'
    });

    expect(config.SERVICE_NAME).toBe('auth');
    expect(config.PORT).toBe(3000);
    expect(config.DB_PORT).toBe(5432);
    expect(config.ACCESS_TTL_SECONDS).toBe(900);
    expect(config.REFRESH_TTL_DAYS).toBe(7);
    expect(config.ARGON2_MEMORY_KIB).toBe(19456);
    expect(config.ARGON2_ITERATIONS).toBe(2);
    expect(config.ARGON2_PARALLELISM).toBe(1);
    expect(config.OUTBOX_INTERVAL_MS).toBe(500);
  });

  it('throws when required JWT_PRIVATE_KEY_B64 is missing', () => {
    expect(() => loadConfig({})).toThrow();
  });

  it('allows overriding parameters through environment variables', () => {
    const config = loadConfig({
      JWT_PRIVATE_KEY_B64: 'some-dummy-b64-key',
      PORT: '3001',
      DB_HOST: 'postgres-custom',
      ACCESS_TTL_SECONDS: '1800',
      ARGON2_ITERATIONS: '3'
    });

    expect(config.PORT).toBe(3001);
    expect(config.DB_HOST).toBe('postgres-custom');
    expect(config.ACCESS_TTL_SECONDS).toBe(1800);
    expect(config.ARGON2_ITERATIONS).toBe(3);
  });
});
