#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  console.error('Missing dependency "js-yaml". Run `npm install` inside tools/validate-templates first.');
  process.exit(2);
}

const ROOT = path.resolve(process.argv[2] || '.');
const VALID_STATUS = new Set(['implemented', 'planned', 'experimental']);
const SEMVER = /^\d+\.\d+\.\d+$/;

function findTemplateFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findTemplateFiles(full, out);
    } else if (entry.name === 'template.yaml') {
      out.push(full);
    }
  }
  return out;
}

function exists(p) {
  return fs.existsSync(p);
}

function nonEmptyDir(p) {
  return exists(p) && fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0;
}

function validateOne(templatePath, allIds, templateRoot) {
  const errors = [];
  const warnings = [];
  const dir = path.dirname(templatePath);
  const rel = path.relative(templateRoot, templatePath);

  let doc;
  try {
    doc = yaml.load(fs.readFileSync(templatePath, 'utf8'));
  } catch (e) {
    return { id: rel, errors: [`invalid YAML: ${e.message}`], warnings: [] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { id: rel, errors: ['template.yaml must contain a mapping'], warnings: [] };
  }

  const required = ['id', 'name', 'version', 'description', 'category', 'subcategory', 'status', 'type', 'actions'];
  for (const field of required) {
    if (doc[field] === undefined) errors.push(`missing required field "${field}"`);
  }

  if (doc.type && doc.type !== 'graph-node') {
    errors.push(`type must be "graph-node", got "${doc.type}"`);
  }

  if (doc.version && !SEMVER.test(doc.version)) {
    errors.push(`version "${doc.version}" is not valid semver (MAJOR.MINOR.PATCH)`);
  }

  if (doc.status && !VALID_STATUS.has(doc.status)) {
    errors.push(`status "${doc.status}" must be one of ${[...VALID_STATUS].join(', ')}`);
  }

  if (doc.id) {
    const dirSegments = path.relative(templateRoot, dir).split(path.sep);
    const idSegments = doc.id.split('.');
    if (dirSegments.length >= 2 && idSegments.length >= 2) {
      const expected = dirSegments.slice(0, 2).join('.');
      const actual = idSegments.slice(0, 2).join('.');
      if (expected !== actual) {
        errors.push(`id "${doc.id}" does not match its directory "${dirSegments.join('/')}" (expected prefix "${expected}")`);
      }
    }
  }

  if (doc.status === 'implemented') {
    const mustExist = [
      ['README.md', path.join(dir, 'README.md')],
      ['inputs.schema.json', path.join(dir, 'inputs.schema.json')],
      ['outputs.schema.json', path.join(dir, 'outputs.schema.json')],
      ['dependencies.json', path.join(dir, 'dependencies.json')],
    ];
    for (const [label, p] of mustExist) {
      if (!exists(p)) errors.push(`status: implemented but missing ${label}`);
    }
    if (!nonEmptyDir(path.join(dir, 'prompts'))) errors.push('status: implemented but prompts/ is missing or empty');
    if (!nonEmptyDir(path.join(dir, 'examples'))) errors.push('status: implemented but examples/ is missing or empty');
    if (!nonEmptyDir(path.join(dir, 'tests')) && (doc.testing || {}).strategy !== 'none') {
      warnings.push('no tests/ found and testing.strategy is not "none"');
    }
    const hasCreates = doc.files && doc.files.create && doc.files.create.length > 0;
    const hasModifies = doc.files && doc.files.modify && doc.files.modify.length > 0;
    if (!hasCreates && !hasModifies) {
      warnings.push('files.create and files.modify are both empty for an implemented node');
    }
    if (hasCreates && !nonEmptyDir(path.join(dir, 'files'))) {
      errors.push('files.create is non-empty but files/ directory is missing or empty');
    }
  }

  for (const [schemaName, schemaFile] of [['inputs.schema.json', 'inputs.schema.json'], ['outputs.schema.json', 'outputs.schema.json']]) {
    const p = path.join(dir, schemaFile);
    if (exists(p)) {
      try {
        JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        errors.push(`${schemaName} is not valid JSON: ${e.message}`);
      }
    }
  }

  const templateIds = ((doc.dependencies || {}).templates || []).map((t) => t.id);
  for (const depId of templateIds) {
    if (!allIds.has(depId)) {
      errors.push(`dependencies.templates references unknown id "${depId}"`);
    }
  }

  return { id: doc.id || rel, errors, warnings };
}

function validateRegistry(templateRoot, results) {
  const registryFile = path.join(templateRoot, 'template-registry.json');
  let committed;
  try {
    committed = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  } catch (error) {
    results.errors.push({ template: 'template-registry.json', message: `missing or invalid registry: ${error.message}` });
    return;
  }

  // The generator is the source of truth for derived tags, dependencies, paths,
  // and ordering. Invoke it on the template root so paths have the same base as
  // the committed registry. The validator's own installation supplies js-yaml.
  const localNodeModules = path.join(__dirname, 'node_modules');
  const generated = spawnSync(
    process.execPath,
    [path.join(__dirname, '../generate-registry/index.js'), templateRoot],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_PATH: [localNodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
      },
    },
  );
  if (generated.error || generated.status !== 0 || generated.stderr) {
    results.errors.push({
      template: 'template-registry.json',
      message: `registry generation failed: ${(generated.error?.message || generated.stderr || `exit ${generated.status}`).trim()}`,
    });
    return;
  }
  let expected;
  try {
    expected = JSON.parse(generated.stdout);
  } catch (error) {
    results.errors.push({ template: 'template-registry.json', message: `registry generator returned invalid JSON: ${error.message}` });
    return;
  }

  if (!expected || typeof expected !== 'object' || !Array.isArray(expected.templates)) {
    results.errors.push({ template: 'template-registry.json', message: 'registry generator must return a templates array' });
    return;
  }

  if (!committed || typeof committed !== 'object' || !Array.isArray(committed.templates)) {
    results.errors.push({ template: 'template-registry.json', message: 'registry must contain a templates array' });
    return;
  }
  const { generatedAt: _committedAt, templates: committedTemplates, ...committedMetadata } = committed;
  const { generatedAt: _expectedAt, templates: expectedTemplates, ...expectedMetadata } = expected;
  if (!isDeepStrictEqual(committedMetadata, expectedMetadata)) {
    results.errors.push({ template: 'template-registry.json', message: 'registry metadata differs from generated catalog; regenerate template-registry.json' });
  }
  if (!isDeepStrictEqual(committedTemplates.map((entry) => entry?.id), expectedTemplates.map((entry) => entry.id))) {
    results.errors.push({ template: 'template-registry.json', message: 'registry identity/order differs from template.yaml inventory; regenerate template-registry.json' });
    return;
  }
  for (let index = 0; index < expectedTemplates.length; index++) {
    if (!isDeepStrictEqual(committedTemplates[index], expectedTemplates[index])) {
      results.errors.push({ template: expectedTemplates[index].id, message: 'registry entry differs from template.yaml; regenerate template-registry.json' });
    }
  }
}

function main() {
  const templateRoot = exists(path.join(ROOT, 'graph-templates')) ? path.join(ROOT, 'graph-templates') : ROOT;
  const files = findTemplateFiles(templateRoot);
  const parsedDocs = files.map((f) => {
    try {
      return { file: f, doc: yaml.load(fs.readFileSync(f, 'utf8')) };
    } catch {
      return { file: f, doc: null };
    }
  });
  const allIds = new Set(parsedDocs.filter((p) => p.doc && typeof p.doc === 'object' && !Array.isArray(p.doc) && p.doc.id).map((p) => p.doc.id));

  const idCounts = new Map();
  for (const { doc } of parsedDocs) {
    if (doc && typeof doc === 'object' && !Array.isArray(doc) && doc.id) idCounts.set(doc.id, (idCounts.get(doc.id) || 0) + 1);
  }

  const results = { valid: true, templatesChecked: files.length, errors: [], warnings: [] };

  for (const [id, count] of idCounts) {
    if (count > 1) {
      results.errors.push({ template: id, message: `duplicate id used by ${count} template.yaml files` });
    }
  }

  for (const file of files) {
    const { id, errors, warnings } = validateOne(file, allIds, templateRoot);
    for (const message of errors) results.errors.push({ template: id, message });
    for (const message of warnings) results.warnings.push({ template: id, message });
  }

  validateRegistry(templateRoot, results);

  results.valid = results.errors.length === 0;
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.valid ? 0 : 1);
}

main();
