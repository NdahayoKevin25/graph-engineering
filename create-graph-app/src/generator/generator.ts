import * as path from 'node:path';
import { execNpmSync } from '../utils/npm';
import { Registry } from '../registry/registry';
import { resolve } from '../resolver/dependency-resolver';
import {
  GenerateOptions,
  GenerateResult,
  GeneratedFileRecord,
  ProjectConfig,
  Template,
} from '../types';
import { CliError } from '../utils/errors';
import { isUsableTargetDir, writeFileEnsuringDir } from '../utils/fs';
import { planTemplateFiles, finalizePlannedWrites, PlannedWrite } from './file-generator';
import { buildPackageJson, buildEnvExample, buildProjectConfigYaml, collectEnvironmentVariables } from './config-generator';
import { buildDocumentation } from './documentation-generator';

export interface GenerationStep {
  label: string;
}

export type ProgressReporter = (step: GenerationStep) => void;

/**
 * The single function every entrypoint (interactive wizard, --config,
 * --non-interactive flags) calls — see docs/architecture.md
 * "Configuration". Never called with an invalid plan; callers run
 * `resolve()` + surface validation errors themselves first if they want to
 * offer the user a chance to fix the selection (the interactive wizard
 * does; --non-interactive hard-fails instead — see cli/index.ts).
 */
export function generate(
  registry: Registry,
  config: ProjectConfig,
  selectedIds: string[],
  options: GenerateOptions,
  onProgress: ProgressReporter = () => {},
): GenerateResult {
  const plan = resolve(registry, selectedIds);
  if (!plan.validation.valid) {
    throw new CliError('Cannot generate: the selected templates are not compatible.', {
      reason: plan.validation.errors.map((e) => `- ${e.message}`).join('\n'),
      suggestion: 'Remove one of the conflicting templates, or add whatever satisfies an unmet requirement.',
    });
  }

  if (!options.dryRun && !isUsableTargetDir(options.targetDir) && !options.force) {
    throw new CliError(`"${options.targetDir}" already exists and is not empty.`, {
      reason: 'create-graph-app refuses to write into a non-empty directory without --force, to avoid clobbering existing work.',
      suggestion: 'Choose a different project name, empty the directory, or re-run with --force.',
    });
  }

  const layout = resolveLayout(plan.templates, options.targetDir);
  const files: GeneratedFileRecord[] = [];

  onProgress({ label: 'Resolving templates' });

  const plannedByApp = new Map<TargetAppKey, PlannedWrite[]>();
  for (const template of plan.templates) {
    onProgress({ label: `Configuring ${template.name}` });
    const appKey = layout.multi ? (template.targetApp === 'root' ? 'root' : template.targetApp) : 'root';
    const appRoot = layout.roots[appKey];
    const writes = planTemplateFiles(template, config, appRoot);
    plannedByApp.set(appKey, [...(plannedByApp.get(appKey) ?? []), ...writes]);
  }

  if (!options.dryRun) {
    for (const [, writes] of plannedByApp) {
      const { writtenFiles } = finalizePlannedWrites(writes);
      for (const absPath of writtenFiles) {
        const write = writes.find((w) => w.absDest === absPath);
        files.push({ templateId: write?.templateId ?? 'unknown', path: absPath, op: write?.op === 'merge' ? 'merge' : write?.op === 'append' ? 'append' : 'create' });
      }
    }
  } else {
    for (const [, writes] of plannedByApp) {
      for (const write of writes) {
        files.push({ templateId: write.templateId, path: write.absDest, op: write.op === 'merge' ? 'merge' : write.op === 'append' ? 'append' : 'create' });
      }
    }
  }

  onProgress({ label: 'Generating package.json' });
  for (const [appKey, root] of Object.entries(layout.roots)) {
    const templatesForApp = plan.templates.filter((t) => (layout.multi ? (t.targetApp === 'root' ? appKey === 'root' : t.targetApp === appKey) : true));
    if (!layout.multi && appKey !== 'root') continue;
    if (templatesForApp.length === 0) continue;
    const packageName = appKey === 'root' ? config.project.name : `${config.project.name}-${appKey}`;
    const { content } = buildPackageJson(packageName, templatesForApp, config);
    if (!options.dryRun) writeFileEnsuringDir(path.join(root, 'package.json'), content);
    files.push({ templateId: '(generated)', path: path.join(root, 'package.json'), op: 'create' });
  }

  if (layout.multi) {
    const workspaceRoot = {
      name: config.project.name,
      version: '0.1.0',
      private: true,
      workspaces: Object.keys(layout.roots)
        .filter((key) => key !== 'root')
        .map((key) => `apps/${key}`),
    };
    if (!options.dryRun) {
      writeFileEnsuringDir(path.join(options.targetDir, 'package.json'), JSON.stringify(workspaceRoot, null, 2) + '\n');
    }
    files.push({ templateId: '(generated)', path: path.join(options.targetDir, 'package.json'), op: 'create' });
  }

  onProgress({ label: 'Creating environment template' });
  const envVars = collectEnvironmentVariables(plan.templates);
  if (!options.dryRun) {
    writeFileEnsuringDir(path.join(options.targetDir, '.env.example'), buildEnvExample(plan.templates));
    writeFileEnsuringDir(path.join(options.targetDir, 'project.config.yaml'), buildProjectConfigYaml(config));
  }
  files.push({ templateId: '(generated)', path: path.join(options.targetDir, '.env.example'), op: 'create' });
  files.push({ templateId: '(generated)', path: path.join(options.targetDir, 'project.config.yaml'), op: 'create' });

  onProgress({ label: 'Generating documentation' });
  const docs = buildDocumentation(config, plan.templates, envVars);
  for (const doc of docs) {
    const fullPath = path.join(options.targetDir, doc.relPath);
    if (!options.dryRun) writeFileEnsuringDir(fullPath, doc.content);
    files.push({ templateId: '(generated)', path: fullPath, op: 'create' });
  }

  if (options.installDependencies && !options.dryRun) {
    onProgress({ label: 'Installing dependencies' });
    for (const root of new Set(Object.values(layout.roots).concat(options.targetDir))) {
      execNpmSync(['install'], { cwd: root, stdio: 'ignore' });
    }
  }

  return {
    targetDir: options.targetDir,
    files,
    dependenciesInstalled: options.installDependencies && !options.dryRun,
    environmentVariables: envVars,
    documentationFiles: docs.map((d) => d.relPath),
  };
}

type TargetAppKey = 'root' | 'web' | 'api';

interface Layout {
  multi: boolean;
  roots: Record<TargetAppKey, string>;
}

/**
 * Full-stack (both a frontend- and a backend-providing template selected)
 * gets the apps/web + apps/api monorepo layout the brief describes.
 * Anything else is single-app: everything lands at the project root,
 * regardless of a template's own `targetApp` — there is exactly one app, so
 * "web vs. api" stops being a meaningful distinction (brief §6: never
 * generate unnecessary folders).
 */
function resolveLayout(templates: Template[], targetDir: string): Layout {
  const hasWeb = templates.some((t) => t.targetApp === 'web');
  const hasApi = templates.some((t) => t.targetApp === 'api');
  const multi = hasWeb && hasApi;

  if (!multi) {
    return { multi: false, roots: { root: targetDir, web: targetDir, api: targetDir } };
  }

  return {
    multi: true,
    roots: { root: targetDir, web: path.join(targetDir, 'apps', 'web'), api: path.join(targetDir, 'apps', 'api') },
  };
}
