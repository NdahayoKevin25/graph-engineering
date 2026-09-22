'use strict';

// Opt-in release check: this installs dependencies in isolated temporary projects.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execNpmSync } = require('./npm-command');
const { Registry, generate } = require('../dist');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-generated-smoke-'));
const registry = Registry.load();
const cases = [
  { name: 'frontend', config: { project: { name: 'smoke-frontend', type: 'frontend' }, frontend: { framework: 'nextjs', stateManagement: 'zustand', ui: 'shadcn' } }, ids: ['frontend.nextjs', 'frontend.zustand', 'frontend.shadcn'] },
  { name: 'backend', config: { project: { name: 'smoke-backend', type: 'backend' }, backend: { framework: 'express' }, database: { provider: 'neon-postgres' }, storage: { provider: 'aws-s3' } }, ids: ['backend.express', 'database.neon-postgres', 'storage.aws-s3'] },
];
cases.push({ name: 'fullstack', config: { ...cases[0].config, ...cases[1].config, frontend: cases[0].config.frontend, project: { name: 'smoke-fullstack', type: 'fullstack' } }, ids: [...cases[0].ids, ...cases[1].ids] });
console.log(`Generated-app smoke workspace: ${root}`);
for (const scenario of cases.filter(c => !process.argv[2] || c.name === process.argv[2])) {
  const targetDir = path.join(root, scenario.name);
  generate(registry, scenario.config, scenario.ids, { targetDir, dryRun: false, force: false, installDependencies: false });
  const run = args => execNpmSync(args, { cwd: targetDir, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
  console.log(`Checking generated ${scenario.name}`);
  run(['install', '--no-audit', '--no-fund']);
  const workspaceArgs = scenario.name === 'fullstack' ? ['--workspaces'] : [];
  run(['run', 'build', ...workspaceArgs]);
  run(['test', ...workspaceArgs]);
}
console.log(`Generated-app smoke checks passed. Artifacts retained at ${root}`);
