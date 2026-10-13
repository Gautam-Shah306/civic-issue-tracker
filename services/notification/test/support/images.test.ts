import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PINNED_IMAGES } from './images.js';

describe('Pinned Container Images Parity', () => {
  it('matches exactly the digests declared in deploy/compose/docker-compose.yml', () => {
    const candidatePaths = [
      resolve(process.cwd(), '../../deploy/compose/docker-compose.yml'),
      resolve(process.cwd(), 'deploy/compose/docker-compose.yml')
    ];

    const composePath = candidatePaths.find((p) => existsSync(p));
    expect(composePath).toBeDefined();

    const composeContent = readFileSync(composePath!, 'utf8');

    // Extract postgres image
    const postgresMatch = composeContent.match(/postgis\/postgis:[^\s]+/);
    expect(postgresMatch).not.toBeNull();
    expect(postgresMatch![0]).toBe(PINNED_IMAGES.postgres);

    // Extract rabbitmq image
    const rabbitMatch = composeContent.match(/rabbitmq:[^\s]+/);
    expect(rabbitMatch).not.toBeNull();
    expect(rabbitMatch![0]).toBe(PINNED_IMAGES.rabbitmq);

    // Extract mailpit image
    const mailpitMatch = composeContent.match(/axllent\/mailpit:[^\s]+/);
    expect(mailpitMatch).not.toBeNull();
    expect(mailpitMatch![0]).toBe(PINNED_IMAGES.mailpit);
  });
});
