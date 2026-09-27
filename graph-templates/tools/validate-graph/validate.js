'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { ARTIFACT_TYPES, normalizeArtifactType, normalizeArchitecture, normalizeManifest, finding } = require('./contracts');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function schemaValidators(templatesRoot) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const name of Object.keys(ARTIFACT_TYPES)) ajv.addSchema(readJson(path.join(templatesRoot, 'artifacts', `${name}.schema.json`)));
  return new Map(Object.entries(ARTIFACT_TYPES).map(([name, type]) => [type, ajv.getSchema(`${name}.schema.json`)]));
}

function cycleIn(edges) {
  const visiting = new Set();
  const visited = new Set();
  function walk(id, stack) {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id);
    for (const dependency of edges.get(id) || []) {
      const cycle = walk(dependency, [...stack, id]);
      if (cycle) return cycle;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  }
  for (const id of edges.keys()) { const cycle = walk(id, []); if (cycle) return cycle; }
  return null;
}

function validate(projectDir, templatesRoot) {
  const errors = [], warnings = [], repairs = [];
  const error = (rule, message, id) => errors.push(finding(rule, message, id));
  const warning = (rule, message, id) => warnings.push(finding(rule, message, id));
  const result = () => ({ valid: errors.length === 0, errors, warnings, repairs });
  let registry, validators;
  try {
    registry = new Map(readJson(path.join(templatesRoot, 'template-registry.json')).templates.map(entry => [entry.id, entry]));
    validators = schemaValidators(templatesRoot);
  } catch (cause) {
    error('invalid-schemas', `Cannot load template contracts: ${cause.message}`);
    return result();
  }

  const artifacts = new Map();
  // Only known artifact filenames are inspected. package.json and arbitrary project JSON are not artifacts.
  for (const [name, type] of Object.entries(ARTIFACT_TYPES)) {
    for (const fileName of [`${name}.json`, `${name}.schema.json`, ...(name === 'database' ? ['database.schema.schema.json'] : [])]) {
      const file = path.join(projectDir, fileName);
      if (!fs.existsSync(file)) continue;
      try {
        const artifact = readJson(file);
        artifact.artifactType = normalizeArtifactType(artifact.artifactType);
        if (artifact.artifactType !== type || !validators.get(type)(artifact)) {
          error('invalid-schemas', `${fileName}: ${artifact.artifactType !== type ? `expected artifactType ${type}` : JSON.stringify(validators.get(type).errors)}`);
          continue;
        }
        if (artifacts.has(type)) error('invalid-schemas', `Multiple files declare ${type}; keep one canonical artifact`);
        else artifacts.set(type, artifact);
      } catch (cause) { error('invalid-schemas', `${fileName}: ${cause.message}`); }
    }
  }
  if (!artifacts.has('architecture')) {
    error('invalid-schemas', 'A valid architecture.json artifact is required');
    return result();
  }
  let architecture;
  try { architecture = normalizeArchitecture(artifacts.get('architecture')); }
  catch (cause) { error('invalid-schemas', cause.message); return result(); }
  const nodes = architecture.data.nodes;
  const byInstance = new Map(), byTemplate = new Map();
  for (const node of nodes) {
    if (byInstance.has(node.instanceId)) error('duplicate-functionality', `Duplicate instanceId "${node.instanceId}"`, node.instanceId);
    byInstance.set(node.instanceId, node);
    byTemplate.set(node.id, [...(byTemplate.get(node.id) || []), node]);
  }
  const dependencies = new Map(nodes.map(node => [node.instanceId, new Set()]));
  function connect(from, to) {
    if (!byInstance.has(from) || !byInstance.has(to)) {
      error('invalid-connections', `Edge ${from} -> ${to} references an unknown instance`);
      return;
    }
    dependencies.get(from).add(to);
    if (byInstance.get(to).order >= byInstance.get(from).order) error('dependency-order', `Prerequisite "${to}" must run before "${from}"`, from);
  }
  for (const node of nodes) {
    const entry = registry.get(node.id);
    if (!entry) { error('missing-dependencies', `Template "${node.id}" is not in the registry`, node.instanceId); continue; }
    if (entry.status !== 'implemented') error('unimplemented-template', `Template "${node.id}" has status "${entry.status}"; only implemented templates can execute`, node.instanceId);
    const declared = entry.dependsOn || [];
    for (const templateId of Object.keys(node.bindings || {})) {
      if (!declared.some(dep => dep.id === templateId && ['requires', 'extends'].includes(dep.relationship))) error('invalid-connections', `Binding "${templateId}" is not a declared prerequisite`, node.instanceId);
    }
    for (const dependency of declared) {
      const candidates = byTemplate.get(dependency.id) || [];
      if (dependency.relationship === 'conflicts') {
        if (candidates.length) error('duplicate-functionality', `Template "${node.id}" conflicts with "${dependency.id}"`, node.instanceId);
        continue;
      }
      if (!['requires', 'extends'].includes(dependency.relationship)) continue;
      const bound = node.bindings?.[dependency.id];
      if (!candidates.length && dependency.relationship === 'extends' && !bound) continue;
      if (bound) {
        if (byInstance.get(bound)?.id !== dependency.id) error('invalid-connections', `Binding "${dependency.id}" -> "${bound}" must select an instance of that template`, node.instanceId);
        else connect(node.instanceId, bound);
      } else if (candidates.length === 1) connect(node.instanceId, candidates[0].instanceId);
      else if (candidates.length === 0) error('missing-dependencies', `Instance "${node.instanceId}" requires template "${dependency.id}"`, node.instanceId);
      else error('ambiguous-dependency', `Instance "${node.instanceId}" must bind "${dependency.id}" to one of: ${candidates.map(candidate => candidate.instanceId).join(', ')}`, node.instanceId);
    }
  }
  for (const edge of architecture.data.edges || []) connect(edge.from, edge.to);
  const cycle = cycleIn(dependencies);
  if (cycle) error('circular-dependencies', `Dependency cycle: ${cycle.join(' -> ')}`);
  const referenced = new Set([...dependencies.values()].flatMap(set => [...set]));
  for (const node of nodes) {
    if (registry.get(node.id)?.category === 'backend' && !referenced.has(node.instanceId)) warning('orphan-nodes', `Instance "${node.instanceId}" is generated but nothing depends on it`, node.instanceId);
  }

  const envFile = path.join(projectDir, '.env.example');
  const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const envNames = new Set([...env.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(match => match[1]));
  for (const node of nodes) {
    for (const variable of registry.get(node.id)?.environment || []) {
      if (variable.required && !envNames.has(variable.name)) {
        warning('missing-environment-variables', `"${variable.name}" is not documented in .env.example`, node.instanceId);
        repairs.push(finding('missing-environment-variables', `Add "${variable.name}=" to .env.example`, node.instanceId));
      }
    }
  }

  const manifestFile = path.join(projectDir, '.graph', 'manifest.json');
  if (fs.existsSync(manifestFile)) {
    try {
      const manifest = normalizeManifest(readJson(manifestFile));
      for (const [instanceId, info] of Object.entries(manifest.nodes)) {
        if (byInstance.get(instanceId)?.id !== info.templateId) {
          error('invalid-connections', `Manifest instance "${instanceId}" does not match the architecture template "${info.templateId}"`, instanceId);
          continue;
        }
        if (!/^\d+\.\d+\.\d+$/.test(info.version)) { error('invalid-schemas', `Invalid manifest version for "${instanceId}"`, instanceId); continue; }
        const current = registry.get(info.templateId);
        if (current && Number(current.version.split('.')[0]) > Number(info.version.split('.')[0])) warning('version-conflicts', `"${instanceId}" is installed at v${info.version}; registry is v${current.version}`, instanceId);
      }
    } catch (cause) { error('invalid-schemas', `manifest.json: ${cause.message}`); }
  }

  const covered = new Set();
  for (const suite of artifacts.get('test.schema')?.data.suites || []) {
    if (suite.instanceId) {
      if (byInstance.get(suite.instanceId)?.id !== suite.nodeId) error('invalid-connections', `Test suite "${suite.file}" has an invalid template/instance pair`);
      else covered.add(suite.instanceId);
    } else {
      const candidates = byTemplate.get(suite.nodeId) || [];
      if (candidates.length === 1) covered.add(candidates[0].instanceId);
      else warning('missing-tests', `Test suite "${suite.file}" must identify a unique instance for "${suite.nodeId}"`);
    }
  }
  for (const node of nodes) {
    const strategy = registry.get(node.id)?.testing?.strategy;
    if (strategy && strategy !== 'none' && !covered.has(node.instanceId)) warning('missing-tests', `Instance "${node.instanceId}" has no matching test suite`, node.instanceId);
  }
  return result();
}

module.exports = { validate, cycleIn };
