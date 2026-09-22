import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import {
  loadTemplates,
  Registry,
  generate,
  configToTemplateIds,
  type ProjectConfig as ScaffoldConfig,
} from "create-graph-app";
import { readJson } from "./util.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export interface TemplateInfo {
  id: string;
  name: string;
  source: "scaffold" | "graph-node";
  status: string;
  description?: string;
  version?: string;
}
interface GraphTemplate {
  id: string;
  name: string;
  status: string;
  description: string;
  version: string;
  path: string;
}
export async function listTemplates(): Promise<TemplateInfo[]> {
  const coarse = loadTemplates().map((t) => ({
    id: `scaffold:${t.id}`,
    name: t.name,
    source: "scaffold" as const,
    status: "implemented",
    description: t.description,
    version: t.version,
  }));
  const graph = await readJson<{ templates: GraphTemplate[] }>(
    path.join(repositoryRoot, "graph-templates/template-registry.json"),
  );
  return [
    ...coarse,
    ...graph.templates.map((t) => ({
      id: `graph-node:${t.id}`,
      name: t.name,
      source: "graph-node" as const,
      status: t.status,
      description: t.description,
      version: t.version,
    })),
  ];
}
export function scaffold(
  config: ScaffoldConfig,
  targetDir: string,
  dryRun = true,
): ReturnType<typeof generate> {
  const registry = new Registry(loadTemplates());
  return generate(registry, config, configToTemplateIds(config), {
    targetDir,
    dryRun,
    force: false,
    installDependencies: false,
  });
}
export async function validateArtifacts(artifactDir: string): Promise<unknown> {
  const require = createRequire(import.meta.url);
  const validator = require(
    path.join(
      repositoryRoot,
      "graph-templates/tools/validate-graph/validate.js",
    ),
  ) as Record<string, any>;
  const fn = validator.validateGraph ?? validator.validate;
  if (typeof fn !== "function")
    throw new Error(
      "Graph artifact validator does not export a runtime function",
    );
  return fn(artifactDir, path.join(repositoryRoot, "graph-templates"));
}
