import * as clack from '@clack/prompts';
import { Registry } from '../registry/registry';
import { ProjectConfig } from '../types';
import { resolve } from '../resolver/dependency-resolver';
import { configToTemplateIds } from '../configuration/mapping';
import { DEFAULT_CONFIG } from '../configuration/defaults';
import { askProject } from './questions/project';
import { askFrontend } from './questions/frontend';
import { askBackend } from './questions/backend';
import { askDatabase } from './questions/database';
import { askStorage } from './questions/storage';
import { printConfigSummary, confirmGeneration } from './summary';

/**
 * Runs the interactive question flow to completion and returns a
 * ProjectConfig — the exact same shape `configFromFlags`/`loadProjectConfigFile`
 * produce, so `cli/index.ts` calls the same `generate()` afterward regardless
 * of how the config was built (brief §10).
 */
export async function runWizard(registry: Registry, initialName?: string): Promise<ProjectConfig> {
  clack.intro('Full-Stack Project Initializer');

  while (true) {
    const project = await askProject(DEFAULT_CONFIG, initialName);
    const frontend = await askFrontend(registry, DEFAULT_CONFIG);
    const backend = await askBackend(registry, DEFAULT_CONFIG);
    const database = await askDatabase(registry, DEFAULT_CONFIG);
    const storage = await askStorage(registry, DEFAULT_CONFIG);

    const config: ProjectConfig = { project, frontend, backend, database, storage };
    const selectedIds = configToTemplateIds(config);
    const plan = resolve(registry, selectedIds);

    printConfigSummary(config, plan.templates);

    if (!plan.validation.valid) {
      clack.log.error('This combination is not valid:');
      for (const error of plan.validation.errors) {
        clack.log.error(`  ✗ ${error.message}`);
      }
      clack.log.info('Let\'s try again.');
      continue;
    }

    for (const warning of plan.validation.warnings) {
      clack.log.warn(warning.message);
    }

    const choice = await confirmGeneration();
    if (choice === 'create') {
      clack.outro('Generating your project…');
      return config;
    }
    if (choice === 'cancel') {
      clack.cancel('Cancelled — no files were created.');
      process.exit(0);
    }
    // 'back' falls through to the top of the loop and re-asks everything.
    // See docs/architecture.md's lifecycle note: this is a deliberate MVP
    // simplification over a true per-step back button.
  }
}
