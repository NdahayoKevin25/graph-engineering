'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { validate, normalizeArchitecture, normalizeManifest, normalizeArtifactType } = require('..');

const templates = path.resolve(__dirname, '../../..');
const example = path.join(templates, 'examples/multi-tenant-saas');
// This is a fixed test contract, not a list inferred from the implementation.
// Fixtures document names with blank values; they never need exported env files.
const requiredEnvironment = [
  ['authentication.jwt', 'ACCESS_TOKEN_SECRET'],
  ['database.neon-postgres.connection', 'DATABASE_URL'],
  ['storage.aws-s3', 'AWS_ENDPOINT_URL_S3'],
  ['storage.aws-s3', 'AWS_REGION'],
  ['storage.aws-s3', 'AWS_ACCESS_KEY_ID'],
  ['storage.aws-s3', 'AWS_SECRET_ACCESS_KEY'],
  ['testing.integration', 'TEST_DATABASE_URL'],
];
const expectedMissingTests = ['database.migrations', 'database.neon-postgres.connection', 'database.transactions', 'testing.api', 'testing.unit'];
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-contract-test-'));
  fs.cpSync(example, dir, { recursive: true, filter: source => path.basename(source) !== '.env.example' });
  fs.writeFileSync(path.join(dir, '.env.example'), requiredEnvironment.map(([, name]) => `${name}=\n`).join(''));
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

test('two complete CRUD entity chains validate against real registry', t => {
  const dir = fixture(t);
  const result = validate(dir, templates);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.warnings.map(w => [w.rule, w.nodeId]).sort(), expectedMissingTests.map(nodeId => ['missing-tests', nodeId]).sort());
  const architecture = JSON.parse(fs.readFileSync(path.join(dir, 'architecture.json'), 'utf8'));
  assert.deepEqual(architecture.data.nodes.filter(n => n.id === 'api.crud').map(n => n.inputs.entityName), ['Project', 'Invoice']);
});

test('omitted environment documentation produces exactly the required variable warnings', t => {
  const dir = fixture(t);
  fs.unlinkSync(path.join(dir, '.env.example'));
  const result = validate(dir, templates);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.warnings.filter(w => w.rule === 'missing-tests').map(w => w.nodeId).sort(), expectedMissingTests);
  assert.deepEqual(
    result.warnings.filter(w => w.rule !== 'missing-tests').map(w => [w.rule, w.nodeId, w.message]).sort(),
    requiredEnvironment.map(([nodeId, name]) => ['missing-environment-variables', nodeId, `"${name}" is not documented in .env.example`]).sort(),
  );
  assert.deepEqual(result.repairs.map(r => [r.rule, r.nodeId, r.message]).sort(),
    requiredEnvironment.map(([nodeId, name]) => ['missing-environment-variables', nodeId, `Add "${name}=" to .env.example`]).sort());
});

test('comments and prefixed names do not satisfy required environment assignments', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '.env.example'), [
    '# ACCESS_TOKEN_SECRET=', 'NOT_DATABASE_URL=', 'AWS_ENDPOINT_URL_S3=',
    'export AWS_REGION=', 'AWS_ACCESS_KEY_ID=', 'AWS_SECRET_ACCESS_KEY=', 'TEST_DATABASE_URL=',
  ].join('\n'));
  const result = validate(dir, templates);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.warnings.filter(w => w.rule !== 'missing-tests').map(w => [w.rule, w.nodeId]).sort(), [
    ['missing-environment-variables', 'authentication.jwt'],
    ['missing-environment-variables', 'database.neon-postgres.connection'],
  ]);
});

test('integration testing requires its own documented database rather than the application fallback', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '.env.example'), requiredEnvironment.filter(([, name]) => name !== 'TEST_DATABASE_URL').map(([, name]) => `${name}=\n`).join(''));
  const result = validate(dir, templates);
  assert.deepEqual(result.warnings.filter(w => w.rule === 'missing-environment-variables').map(w => [w.nodeId, w.message]), [
    ['testing.integration', '"TEST_DATABASE_URL" is not documented in .env.example'],
  ]);
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
