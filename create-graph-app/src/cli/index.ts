#!/usr/bin/env node
import * as path from 'node:path';
import * as clack from '@clack/prompts';
import { Command } from 'commander';
import { Registry } from '../registry/registry';
import { generate } from '../generator/generator';
import { validateBeforeGenerate } from '../validation/validate';
import { configToTemplateIds } from '../configuration/mapping';
import { NONE_CONFIG } from '../configuration/defaults';
import { configFromFlags, loadProjectConfigFile } from '../configuration/loader';
import { runWizard } from './wizard';
import { printGenerationSummary } from './summary';
import { CliError, formatCliError } from '../utils/errors';
import { isTruthyPath } from '../utils/render';
import { ProjectConfig } from '../types';

const packageJson = require('../../package.json') as { version: string };

const program = new Command();
program.name('create-graph-app').description('Interactive full-stack project initializer').version(packageJson.version);

interface SharedFlags {
  dryRun?: boolean;
  nonInteractive?: boolean;
  config?: string;
  debug?: boolean;
  force?: boolean;
  /** commander's negatable `--no-install` sets this to false; defaults to true. */
  install?: boolean;
  frontend?: string;
  state?: string;
  ui?: string;
  backend?: string;
  database?: string;
  storage?: string;
}

function addSharedOptions(command: Command): Command {
  return command
    .option('--dry-run', 'Show what would be generated without writing anything', false)
    .option('--non-interactive', 'Skip the wizard; require --config or flags', false)
    .option('--config <file>', 'Path to a project.config.yaml to reproduce')
    .option('--debug', 'Print full stack traces on error', false)
    .option('--force', 'Write into a non-empty directory', false)
    .option('--no-install', 'Skip npm install after generating')
    .option('--frontend <id>', 'nextjs | none')
    .option('--state <id>', 'zustand | none')
    .option('--ui <id>', 'shadcn | tailwind | none')
    .option('--backend <id>', 'express | none')
    .option('--database <id>', 'neon | neon-postgres | none')
    .option('--storage <id>', 's3 | aws-s3 | none');
}

async function runInit(projectNameArg: string | undefined, flags: SharedFlags): Promise<void> {
  const registry = Registry.load();

  let config: ProjectConfig;

  if (flags.config) {
    config = loadProjectConfigFile(flags.config);
    if (projectNameArg) config = { ...config, project: { ...config.project, name: projectNameArg } };
  } else if (flags.nonInteractive) {
    config = configFromFlags(
      {
        name: projectNameArg,
        frontend: flags.frontend,
        state: flags.state,
        ui: flags.ui,
        backend: flags.backend,
        database: flags.database,
        storage: flags.storage,
      },
      NONE_CONFIG,
    );
  } else {
    config = await runWizard(registry, projectNameArg);
  }

  const targetDir = path.resolve(process.cwd(), config.project.name);
  const validation = validateBeforeGenerate(registry, config, targetDir, { force: Boolean(flags.force) });

  if (!validation.valid) {
    throw new CliError('Cannot generate this project.', {
      reason: validation.errors.map((e) => `- ${e.message}`).join('\n'),
      suggestion: 'Fix the selection (or pass --force if only the target-directory check failed) and try again.',
    });
  }
  for (const warning of validation.warnings) {
    clack.log.warn(warning.message);
  }

  const selectedIds = configToTemplateIds(config);

  if (flags.dryRun) {
    const plan = { order: selectedIds, templates: selectedIds.map((id) => registry.requireById(id)), validation };
    const result = generate(registry, config, selectedIds, {
      targetDir,
      dryRun: true,
      force: true,
      installDependencies: false,
    });
    const context = config as unknown as Record<string, unknown>;
    const included = (pkg: { when?: string }) => !pkg.when || isTruthyPath(context, pkg.when);
    printGenerationSummary(config, plan.templates, {
      files: result.files.length,
      dependencies: plan.templates.reduce(
        (n, t) => n + t.dependencies.dependencies.filter(included).length + t.dependencies.devDependencies.filter(included).length,
        0,
      ),
      environmentVariables: result.environmentVariables.length,
      documentationFiles: result.documentationFiles.length,
    });
    clack.outro('Dry run complete — nothing was written.');
    return;
  }

  const spinner = clack.spinner();
  spinner.start('Creating project');
  const result = generate(
    registry,
    config,
    selectedIds,
    { targetDir, dryRun: false, force: Boolean(flags.force), installDependencies: flags.install !== false },
    (step) => spinner.message(step.label),
  );
  spinner.stop('Project created successfully.');

  printPostGeneration(config, result.environmentVariables.length > 0);
}

function printPostGeneration(config: ProjectConfig, hasEnvVars: boolean): void {
  const steps = ['1. `cd ' + config.project.name + '`'];
  let n = 2;
  if (hasEnvVars) steps.push(`${n++}. Copy \`.env.example\` to \`.env\` and fill in the values`);
  steps.push(`${n++}. Review \`docs/SETUP.md\``);
  steps.push(`${n}. \`npm run dev\``);

  clack.outro(`Success!\n\nYour project is ready:\n\n  cd ${config.project.name}\n\nNext steps:\n\n${steps.join('\n')}`);
}

// `init` is a pure synonym for the bare invocation — NOT a second Command
// with its own duplicate --dry-run/--non-interactive/etc. option
// definitions. Commander gets genuinely confused (silently drops parsed
// option values) when the same flag is declared on both a parent Command
// and one of its subcommands; see the git history on this line for the
// failing reproduction. Stripping a leading literal "init" token before
// commander ever sees it sidesteps the bug entirely and is simpler than
// coordinating global vs. subcommand-local options would be anyway, since
// the two entrypoints are meant to behave identically.
addSharedOptions(program.argument('[project-name]', 'Project name (skips the name prompt)')).action(
  async (projectName: string | undefined, opts: SharedFlags) => {
    await runInit(projectName, opts);
  },
);

program
  .command('list [category]')
  .description('List available templates')
  .action((category?: string) => {
    const registry = Registry.load();
    const categories = category ? [category as any] : registry.categories();
    for (const cat of categories) {
      const templates = registry.listByCategory(cat as any);
      if (templates.length === 0) continue;
      clack.log.message(`\n${capitalize(cat)}\n`);
      for (const template of templates) {
        clack.log.message(`  ${template.id}`);
      }
    }
  });

program
  .command('info <templateId>')
  .description('Show template information')
  .action((templateId: string) => {
    const registry = Registry.load();
    const template = registry.getById(templateId);
    if (!template) {
      throw new CliError(`Unknown template: "${templateId}"`, {
        reason: 'Run `create-graph-app list` to see available template ids.',
      });
    }
    clack.log.message(`${template.name} (${template.id}) v${template.version}`);
    clack.log.message(template.description);
    clack.log.message(`Category: ${template.category}`);
    clack.log.message(`Provides: ${template.provides.join(', ') || '(none)'}`);
    clack.log.message(`Requires: ${template.requires.join(', ') || '(none)'}`);
    if (template.compatibleWith.length) clack.log.message(`Compatible with: ${template.compatibleWith.join(', ')}`);
    if (template.conflictsWith.length) clack.log.message(`Conflicts with: ${template.conflictsWith.join(', ')}`);
    const deps = [...template.dependencies.dependencies, ...template.dependencies.devDependencies];
    if (deps.length) clack.log.message(`Dependencies: ${deps.map((d) => `${d.name}@${d.version}`).join(', ')}`);
    if (template.environment.length) clack.log.message(`Environment variables: ${template.environment.map((e) => e.name).join(', ')}`);
  });

program
  .command('validate')
  .description('Validate an existing project.config.yaml against the current registry')
  .argument('[config-file]', 'Path to project.config.yaml', 'project.config.yaml')
  // A plain argument, not a --config option: commander silently lets a
  // subcommand's own option default win over a value the user actually
  // passed whenever the SAME flag name is also declared on the root
  // program (see the `normalizeInitAlias` comment above for the same class
  // of bug) — using a differently-shaped argument here sidesteps it
  // entirely rather than patching around it per-command.
  .action((configFile: string) => {
    const registry = Registry.load();
    const config = loadProjectConfigFile(path.resolve(process.cwd(), configFile));
    const targetDir = path.resolve(process.cwd());
    const result = validateBeforeGenerate(registry, config, targetDir, { force: true });
    if (result.valid) {
      clack.log.success('Configuration is valid against the current template registry.');
    } else {
      for (const error of result.errors) clack.log.error(error.message);
      process.exitCode = 1;
    }
    for (const warning of result.warnings) clack.log.warn(warning.message);
  });

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Strips a leading literal "init" token (argv[2]) so it never reaches commander as a subcommand name — see the comment above the root .action() registration. */
function normalizeInitAlias(argv: string[]): string[] {
  if (argv[2] === 'init') {
    return [...argv.slice(0, 2), ...argv.slice(3)];
  }
  return argv;
}

export async function run(rawArgv: string[]): Promise<void> {
  const argv = normalizeInitAlias(rawArgv);
  try {
    await program.parseAsync(argv);
  } catch (error) {
    const debug = argv.includes('--debug');
    if (error instanceof CliError) {
      clack.log.error(formatCliError(error));
      if (debug) console.error(error.stack);
      process.exitCode = 1;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run(process.argv);
}
