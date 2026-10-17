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

export interface EventEnvelope<T = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  version: number;
  occurredAt: string;
  correlationId: string;
  payload: T;
}

export interface EventValidator {
  validateEvent(eventType: string, event: unknown): void;
  validateIncomingEvent(eventType: string, event: unknown): { valid: boolean; errors?: string };
}

export function createEventValidator(config: Config): EventValidator {
  const strictAjv = new AjvClass({
    strict: true,
    allErrors: true
  });
  addFormats(strictAjv);

  const tolerantAjv = new AjvClass({
    strict: false,
    removeAdditional: true,
    allErrors: true
  });
  addFormats(tolerantAjv);

  const candidateDirs = [
    config.CONTRACTS_DIR ? resolve(config.CONTRACTS_DIR, 'events') : '',
    config.CONTRACTS_DIR ? resolve(process.cwd(), config.CONTRACTS_DIR, 'events') : '',
    resolve(process.cwd(), '../../contracts/events'),
    resolve(process.cwd(), 'contracts/events'),
    '/app/contracts/events'
  ].filter(Boolean);

  const eventsDir = candidateDirs.find((d) => existsSync(join(d, 'envelope.v1.schema.json')));
  if (!eventsDir) {
    throw new Error(
      `Could not locate contracts/events schemas in any candidate directories: ${candidateDirs.join(', ')}`
    );
  }
  const validEventsDir: string = eventsDir;

  const envelopePath = join(validEventsDir, 'envelope.v1.schema.json');
  const envelopeSchema = JSON.parse(readFileSync(envelopePath, 'utf8'));
  strictAjv.addSchema(envelopeSchema, 'envelope.v1.schema.json');
  tolerantAjv.addSchema(envelopeSchema, 'envelope.v1.schema.json');

  const strictCompiled = new Map<string, ((data: unknown) => boolean) & { errors?: unknown }>();
  const tolerantCompiled = new Map<string, ((data: unknown) => boolean) & { errors?: unknown }>();

  function getStrictValidator(eventType: string) {
    let validator = strictCompiled.get(eventType);
    if (!validator) {
      const schemaFileName = `${eventType}.v1.schema.json`;
      const schemaFilePath = join(validEventsDir, schemaFileName);
      if (!existsSync(schemaFilePath)) {
        throw new Error(`Schema file not found for event type ${eventType}: ${schemaFilePath}`);
      }
      const schema = JSON.parse(readFileSync(schemaFilePath, 'utf8'));
      validator = strictAjv.compile(schema);
      strictCompiled.set(eventType, validator);
    }
    return validator;
  }

  function getTolerantValidator(eventType: string) {
    let validator = tolerantCompiled.get(eventType);
    if (!validator) {
      const schemaFileName = `${eventType}.v1.schema.json`;
      const schemaFilePath = join(validEventsDir, schemaFileName);
      if (!existsSync(schemaFilePath)) {
        throw new Error(`Schema file not found for event type ${eventType}: ${schemaFilePath}`);
      }
      const schema = JSON.parse(readFileSync(schemaFilePath, 'utf8'));
      validator = tolerantAjv.compile(schema);
      tolerantCompiled.set(eventType, validator);
    }
    return validator;
  }

  return {
    validateEvent(eventType: string, event: unknown): void {
      const validator = getStrictValidator(eventType);
      const valid = validator(event);
      if (!valid) {
        const errorText = strictAjv.errorsText(validator.errors);
        throw new Error(`Event validation failed for ${eventType}: ${errorText}`);
      }
    },
    validateIncomingEvent(eventType: string, event: unknown): { valid: boolean; errors?: string } {
      const validator = getTolerantValidator(eventType);
      const valid = validator(event);
      if (!valid) {
        return { valid: false, errors: tolerantAjv.errorsText(validator.errors) };
      }
      return { valid: true };
    }
  };
}
