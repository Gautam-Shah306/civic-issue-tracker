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

const rawAjv =
  (Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default || Ajv2020Module;
const rawAddFormats =
  (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ||
  addFormatsModule;

const AjvClass = rawAjv as unknown as AjvConstructor;
const addFormats = rawAddFormats as unknown as FormatsFunction;

export interface EventValidator {
  validateEvent(eventType: string, event: unknown): void;
}

export function createEventValidator(config: Config): EventValidator {
  const ajv = new AjvClass({
    strict: true,
    allErrors: true
  });
  addFormats(ajv);

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
      `Could not locate contracts/events schemas in any candidate directories: ${candidateDirs.join(', ')}`
    );
  }
  const validEventsDir: string = eventsDir;

  const envelopePath = join(validEventsDir, 'envelope.v1.schema.json');
  const envelopeSchema = JSON.parse(readFileSync(envelopePath, 'utf8'));
  ajv.addSchema(envelopeSchema, 'envelope.v1.schema.json');

  const compiledValidators = new Map<string, ((data: unknown) => boolean) & { errors?: unknown }>();

  function getValidator(eventType: string) {
    let validator = compiledValidators.get(eventType);
    if (!validator) {
      const schemaFileName = `${eventType}.v1.schema.json`;
      const schemaFilePath = join(validEventsDir, schemaFileName);
      if (!existsSync(schemaFilePath)) {
        throw new Error(`Schema file not found for event type ${eventType}: ${schemaFilePath}`);
      }
      const schema = JSON.parse(readFileSync(schemaFilePath, 'utf8'));
      validator = ajv.compile(schema);
      compiledValidators.set(eventType, validator);
    }
    return validator;
  }

  return {
    validateEvent(eventType: string, event: unknown): void {
      const validator = getValidator(eventType);
      const valid = validator(event);
      if (!valid) {
        const errorText = ajv.errorsText(validator.errors);
        throw new Error(`Event validation failed for ${eventType}: ${errorText}`);
      }
    }
  };
}
