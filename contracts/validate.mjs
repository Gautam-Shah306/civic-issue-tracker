import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const schemas = [
  'events/envelope.v1.schema.json',
  'events/user.created.v1.schema.json',
  'events/user.updated.v1.schema.json',
  'events/report.submitted.v1.schema.json',
  'events/report.status-changed.v1.schema.json',
  'events/report.assigned.v1.schema.json',
  'events/category.upserted.v1.schema.json',
  'events/image.processed.v1.schema.json',
  'openapi/problem.v1.schema.json'
];

console.log('Loading and compiling schemas...');
for (const relPath of schemas) {
  const fullPath = path.join(__dirname, relPath);
  const schema = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  ajv.addSchema(schema, relPath);
}

// Compile target schemas
const envelopeValidator = ajv.getSchema('events/envelope.v1.schema.json');
const userCreatedValidator = ajv.getSchema('events/user.created.v1.schema.json');
const userUpdatedValidator = ajv.getSchema('events/user.updated.v1.schema.json');
const reportSubmittedValidator = ajv.getSchema('events/report.submitted.v1.schema.json');
const reportStatusChangedValidator = ajv.getSchema('events/report.status-changed.v1.schema.json');
const reportAssignedValidator = ajv.getSchema('events/report.assigned.v1.schema.json');
const categoryUpsertedValidator = ajv.getSchema('events/category.upserted.v1.schema.json');
const imageProcessedValidator = ajv.getSchema('events/image.processed.v1.schema.json');
const problemValidator = ajv.getSchema('openapi/problem.v1.schema.json');

const requiredEnvelopeKeys = ['eventId', 'eventType', 'version', 'occurredAt', 'correlationId', 'payload'];

let passed = 0;
let failed = 0;

function checkEnvelopeFields(name, data) {
  const keys = Object.keys(data).sort();
  const expected = [...requiredEnvelopeKeys].sort();
  if (keys.length !== 6 || !keys.every((k, i) => k === expected[i])) {
    console.error(`[FAIL] ${name} envelope does not contain exactly the 6 required fields: found ${keys.join(', ')}`);
    failed++;
    return false;
  }
  return true;
}

function runTest(exampleRelPath, validator, expectPass, isEvent = false) {
  const fullPath = path.join(__dirname, exampleRelPath);
  const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));

  const schemaValid = validator(data);

  if (expectPass) {
    if (!schemaValid) {
      console.error(`[FAIL] ${exampleRelPath} expected to pass schema validation but failed:`, validator.errors);
      failed++;
      return;
    }
    if (isEvent && !checkEnvelopeFields(exampleRelPath, data)) {
      return;
    }
    console.log(`[PASS] ${exampleRelPath} validated successfully.`);
    passed++;
  } else {
    // For invalid examples: expect schema failure OR envelope fields failure
    if (!schemaValid) {
      console.log(`[PASS] ${exampleRelPath} correctly rejected by schema.`);
      passed++;
    } else if (isEvent && !checkEnvelopeFields(exampleRelPath, data)) {
      console.log(`[PASS] ${exampleRelPath} correctly rejected by envelope field count check.`);
      passed++;
    } else {
      console.error(`[FAIL] ${exampleRelPath} expected to fail but passed!`);
      failed++;
    }
  }
}

console.log('\nValidating event examples:');
runTest('events/examples/user.created.valid.json', userCreatedValidator, true, true);
runTest('events/examples/user.updated.valid.json', userUpdatedValidator, true, true);
runTest('events/examples/report.submitted.valid.json', reportSubmittedValidator, true, true);
runTest('events/examples/report.status-changed.valid.json', reportStatusChangedValidator, true, true);
runTest('events/examples/report.assigned.valid.json', reportAssignedValidator, true, true);
runTest('events/examples/category.upserted.valid.json', categoryUpsertedValidator, true, true);
runTest('events/examples/image.processed.valid.json', imageProcessedValidator, true, true);

console.log('\nValidating OpenAPI problem examples:');
runTest('openapi/examples/problem.valid.json', problemValidator, true, false);

console.log('\nValidating negative / invalid examples:');
runTest('events/examples/report.submitted.invalid-missing-correlation.json', reportSubmittedValidator, false, true);
runTest('events/examples/user.created.invalid-extra-field.json', userCreatedValidator, false, true);
runTest('events/examples/user.updated.invalid.json', userUpdatedValidator, false, true);
runTest('events/examples/report.assigned.invalid.json', reportAssignedValidator, false, true);
runTest('events/examples/category.upserted.invalid.json', categoryUpsertedValidator, false, true);
runTest('events/examples/report.submitted.invalid-event-version.json', reportSubmittedValidator, false, true);
runTest('events/examples/report.submitted.invalid-missing-occurred-at.json', reportSubmittedValidator, false, true);
runTest('events/examples/image.processed.invalid.json', imageProcessedValidator, false, true);

console.log(`\nValidation Summary: ${schemas.length} schemas compiled, ${passed} tests passed, ${failed} tests failed.`);

if (failed > 0) {
  process.exit(1);
}
