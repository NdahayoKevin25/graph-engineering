#!/usr/bin/env node
'use strict';

/**
 * Brief §30: "Make sure templates are actually included in the published
 * package... Do not rely on the local development filesystem accidentally
 * containing files that will not be published." This runs the REAL `npm
 * pack` (respecting package.json's `files` field exactly as npm publish
 * would), inspects the resulting tarball's file list, and fails loudly if
 * anything required is missing — never trusts what's merely present on disk
 * in this checkout.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execNpmSync } = require('./npm-command');

const packageRoot = path.resolve(__dirname, '..');

function listTarballEntries(tarballPath) {
  // No tar dependency — the entries we need are readable via `tar tzf`,
  // present on macOS/Linux by default; avoids adding a package dependency
  // purely for this one dev-time check.
  const output = execFileSync('tar', ['tzf', tarballPath], { encoding: 'utf8' });
  return output.split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^package\//, ''));
}

function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-graph-app-pack-'));
  console.log(`Running npm pack into ${tmpDir}...`);

  const packOutput = execNpmSync(['pack', '--pack-destination', tmpDir, '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  const [{ filename }] = JSON.parse(packOutput);
  const tarballPath = path.join(tmpDir, filename);

  const entries = listTarballEntries(tarballPath);

  const requiredPrefixes = [
    'dist/cli/index.js',
    'dist/index.js',
    'templates/frontend/nextjs/template.yaml',
    'templates/frontend/zustand/template.yaml',
    'templates/frontend/shadcn/template.yaml',
    'templates/backend/express/template.yaml',
    'templates/database/neon-postgres/template.yaml',
    'templates/storage/aws-s3/template.yaml',
    'schemas/template.schema.json',
    'schemas/project-config.schema.json',
    'schemas/registry.schema.json',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
  ];

  const missing = requiredPrefixes.filter((required) => !entries.includes(required));

  console.log(`Tarball contains ${entries.length} files.`);
  if (missing.length > 0) {
    console.error('\nMissing required files from the published package:');
    for (const file of missing) console.error(`  - ${file}`);
    console.error(
      '\nCheck package.json\'s "files" field — a file present in this checkout is not automatically published.',
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }

  // Also confirm every template's docs/ fragment made it in — a silent gap
  // here would mean generated projects ship with a broken documentation link.
  const templateDocGlobs = entries.filter((e) => /^templates\/.+\/docs\/.+\.md$/.test(e));
  console.log(`Found ${templateDocGlobs.length} template documentation files in the tarball.`);
  if (templateDocGlobs.length < 6) {
    console.error('Expected at least 6 template doc files (one per MVP template) — found fewer.');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n✓ Package contents verified — everything required is actually published.');
}

main();
