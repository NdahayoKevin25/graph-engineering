'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { validate, normalizeArchitecture, normalizeManifest, normalizeArtifactType } = require('..');

const templates = path.resolve(__dirname, '../../..');
const example = path.join(templates, 'examples/multi-tenant-saas');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-contract-test-'));
  fs.cpSync(example, dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function edit(dir, file, change) {
  const target = path.join(dir, file), data = JSON.parse(fs.readFileSync(target, 'utf8'));
  change(data);
  fs.writeFileSync(target, JSON.stringify(data));
}
const has = (result, rule) => result.errors.some(error => error.rule === rule);

test('legacy singleton architecture imports without mutating or losing input data', () => {
  const original = JSON.parse(fs.readFileSync(path.join(templates, 'examples/express-neon-s3-app/architecture.json'), 'utf8'));
  const copy = structuredClone(original), migrated = normalizeArchitecture(original);
  assert.deepEqual(original, copy);
  assert.equal(migrated.version, '2.0.0');
  for (const node of migrated.data.nodes) assert.equal(node.instanceId, node.id);
  assert.equal(validate(path.join(templates, 'examples/express-neon-s3-app'), templates).valid, true);
});

test('two complete CRUD entity chains validate against real registry', () => {
  const result = validate(example, templates);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.warnings.map(w => w.nodeId).sort(), ['database.migrations', 'database.neon-postgres.connection', 'database.transactions', 'testing.api', 'testing.unit']);
  const architecture = JSON.parse(fs.readFileSync(path.join(example, 'architecture.json'), 'utf8'));
  assert.deepEqual(architecture.data.nodes.filter(n => n.id === 'api.crud').map(n => n.inputs.entityName), ['Project', 'Invoice']);
});

test('duplicate invocation identities fail', t => {
  const dir = fixture(t);
  edit(dir, 'architecture.json', data => data.data.nodes[1].instanceId = data.data.nodes[0].instanceId);
  assert.equal(has(validate(dir, templates), 'duplicate-functionality'), true);
});

test('repeated template dependencies require explicit instance binding', t => {
  const dir = fixture(t);
  edit(dir, 'architecture.json', data => delete data.data.nodes.find(n => n.instanceId === 'backend.service:Invoice').bindings);
  assert.equal(has(validate(dir, templates), 'ambiguous-dependency'), true);
});

test('binding cannot silently select the wrong template', t => {
  const dir = fixture(t);
  edit(dir, 'architecture.json', data => data.data.nodes.find(n => n.instanceId === 'backend.service:Invoice').bindings['backend.repository'] = 'backend.controller:Invoice');
  assert.equal(has(validate(dir, templates), 'invalid-connections'), true);
});

test('missing required templates fail even when registry knows the template', t => {
  const dir = fixture(t);
  edit(dir, 'architecture.json', data => data.data.nodes = data.data.nodes.filter(n => n.id !== 'backend.error-handler'));
  assert.equal(has(validate(dir, templates), 'missing-dependencies'), true);
});

test('later prerequisites fail dependency order', t => {
  const dir = fixture(t);
  edit(dir, 'architecture.json', data => data.data.nodes.find(n => n.instanceId === 'backend.repository:Invoice').order = 1000);
  assert.equal(has(validate(dir, templates), 'dependency-order'), true);
});

test('explicit edges participate in cycle detection', t => {
  const dir = fixture(t);
  edit(dir, 'architecture.json', data => data.data.edges.push({ from: 'backend.repository:Invoice', to: 'api.crud:Invoice' }));
  assert.equal(has(validate(dir, templates), 'circular-dependencies'), true);
});

test('edge endpoints are invocation IDs, not repeated template IDs', t => {
  const dir = fixture(t);
  edit(dir, 'architecture.json', data => data.data.edges.push({ from: 'api.crud', to: 'backend.repository' }));
  assert.equal(has(validate(dir, templates), 'invalid-connections'), true);
});

test('orphan detection distinguishes instances of the same backend template', t => {
  const dir = fixture(t);
  edit(dir, 'architecture.json', data => data.data.nodes.push({ id: 'backend.repository', instanceId: 'backend.repository:Unused', order: 1000, inputs: { entityName: 'Unused' } }));
  const result = validate(dir, templates);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.warnings.some(w => w.rule === 'orphan-nodes' && w.nodeId === 'backend.repository:Unused'), true);
  assert.equal(result.warnings.some(w => w.rule === 'orphan-nodes' && w.nodeId === 'backend.repository:Invoice'), false);
});

test('planned templates cannot be selected for execution', t => {
  const dir = fixture(t);
  const planned = JSON.parse(fs.readFileSync(path.join(templates, 'template-registry.json'), 'utf8')).templates.find(n => n.status === 'planned');
  assert.ok(planned);
  edit(dir, 'architecture.json', data => data.data.nodes.push({ id: planned.id, instanceId: planned.id, order: 1000 }));
  assert.equal(has(validate(dir, templates), 'unimplemented-template'), true);
});

test('schema failures are errors and v2 does not invent missing instance IDs', t => {
  const dir = fixture(t);
  edit(dir, 'architecture.json', data => delete data.data.nodes[0].instanceId);
  assert.equal(has(validate(dir, templates), 'invalid-schemas'), true);
});

test('other artifacts undergo actual JSON Schema validation', t => {
  const dir = fixture(t);
  edit(dir, 'database.json', data => data.data.tables[0].columns = 'not-columns');
  assert.equal(has(validate(dir, templates), 'invalid-schemas'), true);
});

test('test coverage cannot apply to every repeated invocation implicitly', t => {
  const dir = fixture(t);
  edit(dir, 'test.json', data => { data.data.suites = data.data.suites.filter(s => s.instanceId !== 'api.crud:Invoice'); });
  const result = validate(dir, templates);
  assert.equal(result.warnings.some(w => w.rule === 'missing-tests' && w.nodeId === 'api.crud:Invoice'), true);
  assert.equal(result.warnings.some(w => w.rule === 'missing-tests' && w.nodeId === 'api.crud:Project'), false);
});

test('manifest retains template IDs independently from invocation keys', () => {
  const manifest = normalizeManifest({ nodes: { 'backend.service': { version: '1.0.0', files: ['service.ts'] } } });
  assert.equal(manifest.schemaVersion, '2.0.0');
  assert.equal(manifest.nodes['backend.service'].templateId, 'backend.service');
  assert.deepEqual(manifest.nodes['backend.service'].files, ['service.ts']);
  assert.throws(() => normalizeManifest({ schemaVersion: '2.0.0', nodes: { 'backend.service:Invoice': { version: '1.0.0' } } }), /templateId/);
});

test('documented artifact aliases normalize but unknown names stay unknown', () => {
  assert.equal(normalizeArtifactType('database.schema.schema.json'), 'database.schema');
  assert.equal(normalizeArtifactType('architecture.schema.json'), 'architecture');
  assert.equal(normalizeArtifactType('made-up.schema'), 'made-up.schema');
});

test('legacy duplicate IDs are rejected instead of merged', () => {
  assert.throws(() => normalizeArchitecture({ version: '1.0.0', artifactType: 'architecture', data: { nodes: [{ id: 'api.crud' }, { id: 'api.crud' }] } }), /repeats template/);
});

test('findings validate against the agent contract and retain legacy check alias', t => {
  const dir = fixture(t);
  edit(dir, 'architecture.json', data => data.data.nodes[0].id = 'missing.template');
  const result = validate(dir, templates);
  const Ajv = require('ajv/dist/2020');
  const check = new Ajv({ strict: false }).compile(JSON.parse(fs.readFileSync(path.join(templates, 'ai/validation-agent/output-schema.json'), 'utf8')));
  assert.equal(check(result), true, JSON.stringify(check.errors));
  for (const item of [...result.errors, ...result.warnings, ...result.repairs]) assert.equal(item.check, item.rule);
});
