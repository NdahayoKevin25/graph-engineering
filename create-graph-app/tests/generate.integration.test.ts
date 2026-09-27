import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry/registry';
import { generate } from '../src/generator/generator';
import { ProjectConfig } from '../src/types';

const registry = Registry.load();
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'create-graph-app-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});


describe('generate(): Next.js + Zustand + shadcn (frontend-only, brief §28)', () => {
  it('produces a single-app frontend layout with no apps/ nesting and no backend files', () => {
    const config: ProjectConfig = {
      project: { name: 'web-only', type: 'frontend' },
      frontend: { framework: 'nextjs', stateManagement: 'zustand', ui: 'shadcn' },
    };
    const targetDir = path.join(tmpRoot, 'web-only');
    generate(registry, config, ['frontend.nextjs', 'frontend.zustand', 'frontend.shadcn'], {
      targetDir,
      dryRun: false,
      force: false,
      installDependencies: false,
    });

    expect(fs.existsSync(path.join(targetDir, 'apps'))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, 'app', 'layout.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'stores', 'exampleStore.ts'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'components', 'ui', 'button.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'components.json'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'src'))).toBe(false); // no backend leaked in
  });
});

describe('generate(): Express + Neon (backend-only, no storage)', () => {
  it('produces a single-app backend layout with no storage files', () => {
    const config: ProjectConfig = { project: { name: 'api-only', type: 'backend' }, backend: { framework: 'express' }, database: { provider: 'neon-postgres' } };
    const targetDir = path.join(tmpRoot, 'api-only');
    generate(registry, config, ['backend.express', 'database.neon-postgres'], {
      targetDir,
      dryRun: false,
      force: false,
      installDependencies: false,
    });

    expect(fs.existsSync(path.join(targetDir, 'apps'))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, 'src', 'app.ts'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'src', 'config', 'database.ts'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'src', 'config', 's3Client.ts'))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, 'app'))).toBe(false); // no frontend leaked in
  });
});

describe('generate(): Express + Neon + S3', () => {
  it('includes storage files alongside backend + database', () => {
    const config: ProjectConfig = {
      project: { name: 'api-storage', type: 'backend' },
      backend: { framework: 'express' },
      database: { provider: 'neon-postgres' },
      storage: { provider: 'aws-s3' },
    };
    const targetDir = path.join(tmpRoot, 'api-storage');
    generate(registry, config, ['backend.express', 'database.neon-postgres', 'storage.aws-s3'], {
      targetDir,
      dryRun: false,
      force: false,
      installDependencies: false,
    });

    expect(fs.existsSync(path.join(targetDir, 'src', 'config', 's3Client.ts'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'src', 'utils', 'storage.ts'))).toBe(true);

    const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@aws-sdk/client-s3']).toBeDefined();
    expect(pkg.dependencies['@neondatabase/serverless']).toBeDefined();
    expect(pkg.dependencies.express).toBeDefined();
  });
});

describe('generate(): full stack — Next.js + Zustand + shadcn + Express + Neon + S3 (brief §28/§48)', () => {
  const config: ProjectConfig = {
    project: { name: 'full-stack', type: 'fullstack' },
    frontend: { framework: 'nextjs', stateManagement: 'zustand', ui: 'shadcn' },
    backend: { framework: 'express' },
    database: { provider: 'neon-postgres' },
    storage: { provider: 'aws-s3' },
  };
  const allIds = ['frontend.nextjs', 'frontend.zustand', 'frontend.shadcn', 'backend.express', 'database.neon-postgres', 'storage.aws-s3'];

  it('produces the apps/web + apps/api monorepo layout', () => {
    const targetDir = path.join(tmpRoot, 'full-stack');
    generate(registry, config, allIds, { targetDir, dryRun: false, force: false, installDependencies: false });

    expect(fs.existsSync(path.join(targetDir, 'apps', 'web', 'app', 'layout.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'apps', 'api', 'src', 'app.ts'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'apps', 'web', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'apps', 'api', 'package.json'))).toBe(true);
  });

  it('generates one root package.json with npm workspaces, never merged with an app package.json', () => {
    const targetDir = path.join(tmpRoot, 'full-stack');
    generate(registry, config, allIds, { targetDir, dryRun: false, force: false, installDependencies: false });

    const rootPkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8'));
    expect(rootPkg.workspaces).toEqual(['apps/web', 'apps/api']);
    expect(rootPkg.dependencies).toBeUndefined();
  });

  it('generates .env.example, project.config.yaml, and root README.md documenting every selected template', () => {
    const targetDir = path.join(tmpRoot, 'full-stack');
    const result = generate(registry, config, allIds, { targetDir, dryRun: false, force: false, installDependencies: false });

    expect(fs.existsSync(path.join(targetDir, '.env.example'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'project.config.yaml'))).toBe(true);
    const readme = fs.readFileSync(path.join(targetDir, 'README.md'), 'utf8');
    expect(readme).toContain('Next.js');
    expect(readme).toContain('Express.js');
    expect(readme).toContain('AWS S3');

    // docs/templates/ has exactly the 6 selected templates, nothing more (brief §14/§16)
    const templateDocs = fs.readdirSync(path.join(targetDir, 'docs', 'templates')).sort();
    expect(templateDocs).toEqual([
      'backend.express.md',
      'database.neon-postgres.md',
      'frontend.nextjs.md',
      'frontend.shadcn.md',
      'frontend.zustand.md',
      'storage.aws-s3.md',
    ]);
    expect(result.environmentVariables.length).toBeGreaterThan(0);
  });

  it('refuses to write into a non-empty target directory without --force', () => {
    const targetDir = path.join(tmpRoot, 'occupied');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'existing.txt'), 'hi');

    expect(() =>
      generate(registry, config, allIds, { targetDir, dryRun: false, force: false, installDependencies: false }),
    ).toThrow();
  });

  it('dry-run reports files without writing any', () => {
    const targetDir = path.join(tmpRoot, 'dry-run-target');
    const result = generate(registry, config, allIds, { targetDir, dryRun: true, force: false, installDependencies: false });

    expect(result.files.length).toBeGreaterThan(0);
    expect(fs.existsSync(targetDir)).toBe(false);
  });
});
