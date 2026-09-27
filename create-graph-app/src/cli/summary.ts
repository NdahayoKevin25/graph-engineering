import * as clack from '@clack/prompts';
import { ProjectConfig, Template } from '../types';
import { promptOrExit } from './prompt-helpers';

export function printConfigSummary(config: ProjectConfig, templates: Template[]): void {
  const lines: string[] = [`Project\n  ${config.project.name}\n`];

  const byCategory = new Map<string, Template[]>();
  for (const template of templates) {
    const list = byCategory.get(template.category) ?? [];
    list.push(template);
    byCategory.set(template.category, list);
  }
  for (const [category, list] of byCategory) {
    lines.push(`${capitalize(category)}`);
    for (const template of list) lines.push(`  ✓ ${template.name}`);
    lines.push('');
  }

  clack.note(lines.join('\n').trim(), 'Your project configuration');
}

export interface GenerationCounts {
  files: number;
  dependencies: number;
  environmentVariables: number;
  documentationFiles: number;
}

export function printGenerationSummary(config: ProjectConfig, templates: Template[], counts: GenerationCounts): void {
  const lines = [
    `Project\n  ${config.project.name}\n`,
  ];
  const byCategory = new Map<string, Template[]>();
  for (const template of templates) {
    const list = byCategory.get(template.category) ?? [];
    list.push(template);
    byCategory.set(template.category, list);
  }
  for (const [category, list] of byCategory) {
    lines.push(`${capitalize(category)}`);
    for (const template of list) lines.push(`  ✓ ${template.name}`);
    lines.push('');
  }
  lines.push(`Files to generate\n  ${counts.files}\n`);
  lines.push(`Dependencies\n  ${counts.dependencies}\n`);
  lines.push(`Environment variables\n  ${counts.environmentVariables}\n`);
  lines.push(`Documentation\n  ${counts.documentationFiles} files`);

  clack.note(lines.join('\n').trim(), 'Ready to generate');
}

export type ConfirmChoice = 'create' | 'back' | 'cancel';

export async function confirmGeneration(): Promise<ConfirmChoice> {
  return promptOrExit(
    clack.select({
      message: 'Continue?',
      options: [
        { value: 'create', label: 'Create project' },
        { value: 'back', label: 'Go back' },
        { value: 'cancel', label: 'Cancel' },
      ],
    }),
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
