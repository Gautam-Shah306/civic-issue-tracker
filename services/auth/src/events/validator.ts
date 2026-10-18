import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { Config } from '../config.js';

type AjvConstructor = new (opts?: Record<string, unknown>) => {
  addSchema(schema: unknown, key?: string): void;
  compile(schema: unknown): ((data: unknown) => boolean) & { errors?: unknown };
  errorsText(errors?: unknown, options?: unknown): string;
  errors?: unknown;
};

type FormatsFunction = (ajv: unknown) => void;

// Support both ESM default import and CJS interop
const rawAjv =
  (Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default || Ajv2020Module;
const rawAddFormats =
  (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ||
  addFormatsModule;

const AjvClass = rawAjv as unknown as AjvConstructor;
const addFormats = rawAddFormats as unknown as FormatsFunction;

export interface EventValidator {
  validateUserCreated(event: unknown): void;
  validateUserUpdated(event: unknown): void;
}

export function createEventValidator(config: Config): EventValidator {
  const ajv = new AjvClass({
    strict: true,
    allErrors: true
  });
  addFormats(ajv);

  // Look for contracts events schema files
  const candidateDirs = [
    resolve(config.CONTRACTS_DIR, 'events'),
    resolve(process.cwd(), config.CONTRACTS_DIR, 'events'),
    resolve(process.cwd(), '../../contracts/events'),
    resolve(process.cwd(), 'contracts/events'),
    '/app/contracts/events'
  ];

  const eventsDir = candidateDirs.find((d) => existsSync(join(d, 'envelope.v1.schema.json')));
  if (!eventsDir) {
    throw new Error(
      `Could not locate contracts/events schemas in any of candidate directories: ${candidateDirs.join(', ')}`
    );
  }

  const envelopePath = join(eventsDir, 'envelope.v1.schema.json');
  const userCreatedPath = join(eventsDir, 'user.created.v1.schema.json');
  const userUpdatedPath = join(eventsDir, 'user.updated.v1.schema.json');

  const envelopeSchema = JSON.parse(readFileSync(envelopePath, 'utf8'));
  const userCreatedSchema = JSON.parse(readFileSync(userCreatedPath, 'utf8'));
  const userUpdatedSchema = JSON.parse(readFileSync(userUpdatedPath, 'utf8'));

  ajv.addSchema(envelopeSchema, 'envelope.v1.schema.json');
  const validateCreated = ajv.compile(userCreatedSchema);
  const validateUpdated = ajv.compile(userUpdatedSchema);

  return {
    validateUserCreated(event: unknown) {
      const valid = validateCreated(event);
      if (!valid) {
        const errorMsg = ajv.errorsText(validateCreated.errors, { separator: '; ' });
        throw new Error(`Invalid user.created event: ${errorMsg}`);
      }
    },
    validateUserUpdated(event: unknown) {
      const valid = validateUpdated(event);
      if (!valid) {
        const errorMsg = ajv.errorsText(validateUpdated.errors, { separator: '; ' });
        throw new Error(`Invalid user.updated event: ${errorMsg}`);
      }
    }
  };
}
