'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const validator = path.join(__dirname, 'index.js');
const generator = path.join(__dirname, '../generate-registry/index.js');
const nodePath = [path.join(__dirname, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter);

function run(script, root) {
  const result = spawnSync(process.execPath, [script, root], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: nodePath },
  });
  assert.ifError(result.error);
  return result;
}

function writeTemplate(root, name, description = 'Example node') {
  const directory = path.join(root, 'api', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'template.yaml'),
    `id: api.${name}\nname: ${name}\nversion: 1.0.0\ndescription: ${description}\ncategory: api\nsubcategory: ${name}\nstatus: planned\ntype: graph-node\nactions: [generate]\ninputs: []\noutputs: []\ndependencies: { templates: [] }\ncompatible_with: { upstream: [], downstream: [] }\n`,
  );
}

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-template-validator-'));
  const root = path.join(parent, 'graph-templates');
  fs.mkdirSync(root);
  writeTemplate(root, 'demo');
  const generated = run(generator, root);
  assert.equal(generated.status, 0, generated.stderr);
  const registryFile = path.join(root, 'template-registry.json');
  fs.writeFileSync(registryFile, generated.stdout);
  return { parent, root, registryFile };
}

test('accepts the generated registry regardless of its timestamp or caller root', () => {
  const { parent, root, registryFile } = fixture();
  try {
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    assert.equal(registry.templates[0].path, 'api/demo');
    registry.generatedAt = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(registryFile, JSON.stringify(registry));
    for (const argument of [root, parent]) {
      const result = run(validator, argument);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).valid, true);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('does not advertise conflicting nodes as compatible', () => {
  const { parent, root } = fixture();
  try {
    writeTemplate(root, 'other');
    fs.writeFileSync(
      path.join(root, 'api', 'demo', 'template.yaml'),
      'id: api.demo\nname: demo\nversion: 1.0.0\ncategory: api\nsubcategory: demo\nstatus: planned\ntype: graph-node\nactions: [generate]\ninputs: []\noutputs: []\ndependencies:\n  templates:\n    - { id: api.other, relationship: conflicts }\ncompatible_with: { upstream: [], downstream: [] }\n',
    );
    const generated = run(generator, root);
    assert.equal(generated.status, 0, generated.stderr);
    const demo = JSON.parse(generated.stdout).templates.find(
      (entry) => entry.id === 'api.demo',
    );
    assert.deepEqual(demo.dependsOn, [
      { id: 'api.other', relationship: 'conflicts' },
    ]);
    assert.equal(demo.compatibleNodes.includes('api.other'), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('rejects stale entry fields after a template.yaml change', () => {
  const { parent, root } = fixture();
  try {
    writeTemplate(root, 'demo', 'Changed description');
    const result = run(validator, root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /registry entry differs from template.yaml/);
    assert.match(result.stdout, /api.demo/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('rejects omitted nodes, reordered or edited entries, and incorrect counts', () => {
  const { parent, root, registryFile } = fixture();
  try {
    writeTemplate(root, 'extra');
    let result = run(validator, root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /registry identity\/order differs/);

    const generated = run(generator, root);
    assert.equal(generated.status, 0, generated.stderr);
    const registry = JSON.parse(generated.stdout);
    registry.templates[0].status = 'implemented';
    registry.templateCount = 99;
    fs.writeFileSync(registryFile, JSON.stringify(registry));
    result = run(validator, root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /registry metadata differs/);
    assert.match(result.stdout, /registry entry differs/);

    registry.templates.reverse();
    fs.writeFileSync(registryFile, JSON.stringify(registry));
    result = run(validator, root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /registry identity\/order differs/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('requires a readable registry', () => {
  const { parent, root, registryFile } = fixture();
  try {
    fs.unlinkSync(registryFile);
    const result = run(validator, root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /missing or invalid registry/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('reports a scalar template document instead of crashing', () => {
  const { parent, root } = fixture();
  try {
    fs.writeFileSync(path.join(root, 'api', 'demo', 'template.yaml'), 'null\n');
    const result = run(validator, root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /template.yaml must contain a mapping/);
    assert.equal(JSON.parse(result.stdout).valid, false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
