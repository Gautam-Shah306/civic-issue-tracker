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

export interface ConsumerEventValidator {
  validateEnvelope(data: unknown): { valid: boolean; errors?: string };
  validatePayload(eventType: string, payload: unknown): { valid: boolean; errors?: string };
}

export function createEventValidator(config: Config): ConsumerEventValidator {
  const ajv = new AjvClass({
    strict: false,
    removeAdditional: true,
    allErrors: true
  });
  addFormats(ajv);

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
      `Could not locate contracts/events schemas in candidate directories: ${candidateDirs.join(', ')}`
    );
  }
  const validEventsDir: string = eventsDir;

  const envelopePath = join(validEventsDir, 'envelope.v1.schema.json');
  const envelopeSchema = JSON.parse(readFileSync(envelopePath, 'utf8'));
  ajv.addSchema(envelopeSchema, 'envelope.v1.schema.json');
  const envelopeValidator = ajv.compile(envelopeSchema);

  const compiledPayloadValidators = new Map<
    string,
    ((data: unknown) => boolean) & { errors?: unknown }
  >();

  function getPayloadValidator(eventType: string) {
    let validator = compiledPayloadValidators.get(eventType);
    if (!validator) {
      const schemaFileName = `${eventType}.v1.schema.json`;
      const schemaFilePath = join(validEventsDir, schemaFileName);
      if (!existsSync(schemaFilePath)) {
        return null;
      }
      const schema = JSON.parse(readFileSync(schemaFilePath, 'utf8'));
      validator = ajv.compile(schema);
      compiledPayloadValidators.set(eventType, validator);
    }
    return validator;
  }

  return {
    validateEnvelope(data: unknown) {
      const valid = envelopeValidator(data);
      if (!valid) {
        return { valid: false, errors: ajv.errorsText(envelopeValidator.errors) };
      }
      return { valid: true };
    },
    validatePayload(eventType: string, event: unknown) {
      const validator = getPayloadValidator(eventType);
      if (!validator) {
        // Unknown payload schema
        return { valid: false, errors: `No schema found for event type: ${eventType}` };
      }
      const valid = validator(event);
      if (!valid) {
        return { valid: false, errors: ajv.errorsText(validator.errors) };
      }
      return { valid: true };
    }
  };
}
