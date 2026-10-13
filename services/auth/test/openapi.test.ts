import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('OpenAPI Contract Drift Check', () => {
  it('matches the committed contracts/openapi/auth.v1.openapi.json specification exactly', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const keyB64 = Buffer.from(pem).toString('base64');

    const config = loadConfig({
      SERVICE_NAME: 'auth',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      JWT_PRIVATE_KEY_B64: keyB64
    });

    const app = await buildApp(config);
    await app.ready();
    const rawSpec = app.swagger();
    const generatedSpec = JSON.parse(JSON.stringify(rawSpec));

    // Sort keys recursively
    function sortKeys(obj: unknown): unknown {
      if (obj === null || typeof obj !== 'object') {
        return obj;
      }
      if (Array.isArray(obj)) {
        return obj.map(sortKeys);
      }
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
        sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
      }
      return sorted;
    }

    const candidatePaths = [
      resolve(process.cwd(), 'contracts/openapi/auth.v1.openapi.json'),
      resolve(process.cwd(), '../../contracts/openapi/auth.v1.openapi.json')
    ];

    const targetPath = candidatePaths.find((p) => existsSync(p));
    expect(targetPath).toBeDefined();

    const committedContent = readFileSync(targetPath!, 'utf8');
    const committedJson = JSON.parse(committedContent);

    expect(sortKeys(generatedSpec)).toEqual(sortKeys(committedJson));
    await app.close();
  });
});
