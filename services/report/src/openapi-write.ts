import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const keyB64 = Buffer.from(pem).toString('base64');

  const dummyEnv = {
    SERVICE_NAME: 'report',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    JWT_PUBLIC_KEY_B64: keyB64
  };

  const config = loadConfig(dummyEnv);
  const app = await buildApp(config);
  await app.ready();

  const spec = app.swagger();

  // Sort keys recursively for deterministic output
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

  const deterministicJson = JSON.stringify(sortKeys(spec), null, 2) + '\n';

  const candidatePaths = [
    resolve(process.cwd(), 'contracts/openapi/report.v1.openapi.json'),
    resolve(process.cwd(), '../../contracts/openapi/report.v1.openapi.json'),
    resolve(import.meta.dirname, '../../../contracts/openapi/report.v1.openapi.json')
  ];

  const targetPath =
    candidatePaths.find((p) => existsSync(resolve(p, '..'))) ||
    resolve(process.cwd(), '../../contracts/openapi/report.v1.openapi.json');

  writeFileSync(targetPath, deterministicJson, 'utf8');
  console.log(`Deterministic OpenAPI spec written to ${targetPath}`);
  await app.close();
}

main().catch((err) => {
  console.error('Failed to write OpenAPI spec:', err);
  process.exit(1);
});
