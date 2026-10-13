import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PINNED_IMAGES } from './images.js';

describe('Pinned Container Images Parity', () => {
  it('matches exactly the Redis digest declared in deploy/compose/docker-compose.yml', () => {
    const candidatePaths = [
      resolve(process.cwd(), '../../deploy/compose/docker-compose.yml'),
      resolve(process.cwd(), 'deploy/compose/docker-compose.yml')
    ];

    const composePath = candidatePaths.find((p) => existsSync(p));
    expect(composePath).toBeDefined();

    const composeContent = readFileSync(composePath!, 'utf8');

    // Extract redis image
    const redisMatch = composeContent.match(/redis:[^\s]+/);
    expect(redisMatch).not.toBeNull();
    expect(redisMatch![0]).toBe(PINNED_IMAGES.redis);
  });
});
