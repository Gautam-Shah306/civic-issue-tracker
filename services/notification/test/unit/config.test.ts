import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('Notification Config', () => {
  it('throws on invalid configuration', () => {
    expect(() =>
      loadConfig({ DB_PASSWORD: undefined as unknown as string, DB_PORT: 'not-a-number' })
    ).toThrow(/Invalid configuration/);
  });
});
