import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 180000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/healthcheck.ts'],
      thresholds: {
        lines: 60,
        branches: 60,
        functions: 60,
        statements: 60
      }
    }
  }
});
