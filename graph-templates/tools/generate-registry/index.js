#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  console.error('Missing dependency "js-yaml". Run `npm install` inside tools/generate-registry first.');
  process.exit(2);
}

const ROOT = path.resolve(process.argv[2] || '.');
const KEYWORDS = [
  'crud', 'auth', 'jwt', 's3', 'storage', 'postgres', 'drizzle', 'docker', 'ci',
  'rbac', 'tenant', 'pagination', 'filtering', 'sorting', 'validation', 'test',
  'migration', 'transaction', 'seed', 'presigned', 'upload', 'download', 'delete',
  'webhook', 'search', 'refresh', 'password', 'session', 'oauth', 'permission', 'role',
];

function findTemplateFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTemplateFiles(full, out);
    else if (entry.name === 'template.yaml') out.push(full);
  }
  return out;
}

function deriveTags(doc) {
  const tags = new Set([doc.category, doc.subcategory].filter(Boolean));
  for (const pkg of ((doc.dependencies || {}).packages || [])) {
    tags.add(pkg.name.replace(/^@[^/]+\//, ''));
  }
  const haystack = `${doc.id || ''} ${doc.description || ''}`.toLowerCase();
  for (const kw of KEYWORDS) {
    if (haystack.includes(kw)) tags.add(kw);
  }
  return [...tags];
}

function main() {
  const templatesDir = path.join(ROOT, 'graph-templates');
  const scanDir = fs.existsSync(templatesDir) ? templatesDir : ROOT;
  const files = findTemplateFiles(scanDir);

  const templates = [];
  for (const file of files) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`skipping ${path.relative(ROOT, file)}: invalid YAML (${e.message})`);
      continue;
    }
    if (!doc || !doc.id) {
      console.error(`skipping ${path.relative(ROOT, file)}: no "id" field`);
      continue;
    }

    const compatibleNodes = new Set([
      ...(((doc.compatible_with || {}).upstream) || []),
      ...(((doc.compatible_with || {}).downstream) || []),
      ...(((doc.dependencies || {}).templates) || []).map((t) => t.id),
    ]);

    templates.push({
      id: doc.id,
      name: doc.name || doc.id,
      version: doc.version || '0.0.0',
      category: doc.category,
      subcategory: doc.subcategory,
      status: doc.status || 'planned',
      description: doc.description ? String(doc.description).trim().replace(/\s+/g, ' ') : '',
      tags: deriveTags(doc),
      inputs: ((doc.inputs || [])).map((i) => i.name),
      outputs: ((doc.outputs || [])).map((o) => o.name),
      dependsOn: ((doc.dependencies || {}).templates) || [],
      environment: ((doc.environment || {}).variables) || [],
      testing: doc.testing || { strategy: 'none' },
      compatibleNodes: [...compatibleNodes],
      path: path.relative(ROOT, path.dirname(file)),
    });
  }

  templates.sort((a, b) => a.id.localeCompare(b.id));

  const registry = {
    $schema: 'template-registry.schema.json',
    generatedAt: new Date().toISOString(),
    templateCount: templates.length,
    templates,
  };

  console.log(JSON.stringify(registry, null, 2));
}

main();
