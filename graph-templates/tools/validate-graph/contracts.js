'use strict';

const ARTIFACT_TYPES = Object.freeze({
  requirements: 'requirements', architecture: 'architecture', database: 'database.schema',
  api: 'api.schema', auth: 'auth.schema', storage: 'storage.schema', frontend: 'frontend.schema',
  integration: 'integration.schema', test: 'test.schema', deployment: 'deployment.schema',
});

/** Accept documented filename/type aliases only; never rewrite template identities. */
function normalizeArtifactType(value) {
  if (typeof value !== 'string') return value;
  const name = value.replace(/\.json$/, '').replace(/\.schema(?:\.schema)?$/, '');
  return ARTIFACT_TYPES[name] || value;
}

/** Copy legacy singleton plans into v2. Duplicate legacy IDs are ambiguous, not inferred. */
function normalizeArchitecture(artifact) {
  const result = structuredClone(artifact);
  result.artifactType = normalizeArtifactType(result.artifactType);
  if (!/^1\./.test(result.version)) return result;
  const seen = new Set();
  for (const node of result.data.nodes) {
    if (seen.has(node.id)) throw new Error(`Legacy architecture repeats template "${node.id}"; migrate with explicit instanceId and bindings`);
    seen.add(node.id);
    node.instanceId = node.id;
  }
  result.version = '2.0.0';
  return result;
}

function normalizeManifest(manifest) {
  const result = structuredClone(manifest);
  if (!result || typeof result !== 'object' || Array.isArray(result) || !result.nodes || typeof result.nodes !== 'object' || Array.isArray(result.nodes)) {
    throw new Error('Manifest must be an object with a nodes map');
  }
  if (result.schemaVersion !== undefined && result.schemaVersion !== '1.0.0' && result.schemaVersion !== '2.0.0') {
    throw new Error(`Unsupported manifest schemaVersion "${result.schemaVersion}"`);
  }
  for (const [instanceId, info] of Object.entries(result.nodes)) {
    if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error(`Invalid manifest entry "${instanceId}"`);
    if (result.schemaVersion === '2.0.0' && typeof info.templateId !== 'string') throw new Error(`Manifest entry "${instanceId}" requires templateId`);
    info.templateId = info.templateId || instanceId;
  }
  result.schemaVersion = '2.0.0';
  return result;
}

/** Keep the legacy `check` key while emitting the canonical agent-schema `rule`. */
function finding(rule, message, instanceId) {
  return { rule, check: rule, message, ...(instanceId ? { nodeId: instanceId } : {}) };
}

module.exports = { ARTIFACT_TYPES, normalizeArtifactType, normalizeArchitecture, normalizeManifest, finding };
