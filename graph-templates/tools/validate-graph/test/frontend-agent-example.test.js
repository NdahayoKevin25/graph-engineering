'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const catalogRoot = path.resolve(__dirname, '../../..');
const exampleFile = path.join(catalogRoot, 'ai/frontend-agent/examples/dashboard.json');
const schemaFile = path.join(catalogRoot, 'artifacts/frontend.schema.json');
const example = JSON.parse(fs.readFileSync(exampleFile, 'utf8'));

function validator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(catalogRoot, 'artifacts/requirements.schema.json'), 'utf8')));
  ajv.addSchema(JSON.parse(fs.readFileSync(schemaFile, 'utf8')));
  return ajv.getSchema('frontend.schema.json');
}

test('dashboard example validates and resolves page component kinds before node selection', () => {
  assert.equal(path.resolve(path.dirname(exampleFile), example.output.$schema), schemaFile);
  const validate = validator();
  assert.equal(validate(example.output), true, JSON.stringify(validate.errors));
  const definitions = example.output.data.components;
  const byName = new Map(definitions.map(component => [component.name, component]));
  assert.equal(byName.size, definitions.length, 'component definitions must be unique');
  const usedKinds = new Set();
  for (const page of example.output.data.pages) {
    assert.equal(Object.hasOwn(page, 'kind'), false);
    for (const name of page.components) {
      assert.ok(byName.has(name), `unresolved page component ${name}`);
      usedKinds.add(byName.get(name).kind);
    }
  }
  assert.equal(usedKinds.has('dashboard'), true);
  assert.deepEqual(example.resolvedNodeSequence, [
    'project.nextjs', 'frontend.nextjs', 'frontend.authentication',
    'frontend.forms', 'frontend.tables', 'frontend.dashboards',
  ]);
  const invalid = structuredClone(example.output);
  invalid.data.pages[0].kind = 'dashboard';
  assert.equal(validate(invalid), false, 'page.kind must remain disallowed by the schema');
});
