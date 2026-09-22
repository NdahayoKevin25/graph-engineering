import { mkdir, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import envPaths from "env-paths";
import { z } from "zod";
import {
  assertProjectConfig,
  DEFAULT_POLICY,
  SCHEMA_VERSION,
  type ProjectConfig,
  type ProviderConfig,
} from "@graph-engineering/contracts";
import { id, readJson, writeJson } from "./util.js";

export const PROJECT_FILE = ".graph/project.json";
export async function loadProject(root: string): Promise<ProjectConfig> {
  const value = await readJson<unknown>(path.join(root, PROJECT_FILE));
  assertProjectConfig(value);
  return value;
}
export async function initializeProject(
  root: string,
  name?: string,
): Promise<ProjectConfig> {
  const absolute = await realpath(root);
  try {
    return await loadProject(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config: ProjectConfig = {
    version: SCHEMA_VERSION,
    projectId: id(),
    name: name ?? path.basename(absolute),
    policy: structuredClone(DEFAULT_POLICY),
    verification: [],
  };
  await writeJson(path.join(absolute, PROJECT_FILE), config);
  return config;
}
export function projectDataDir(projectId: string): string {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(projectId))
    throw new Error("Invalid project ID");
  return path.join(
    process.env.GRAPH_ENGINE_DATA_DIR ??
      envPaths("graph-engineering", { suffix: "" }).data,
    "projects",
    projectId,
  );
}
const providerSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    kind: z.enum(["local", "openai", "anthropic", "codex", "claude", "cursor"]),
    model: z.string().min(1),
    endpoint: z.string().url().optional(),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    efforts: z.array(z.string()).optional(),
    defaultEffort: z.string().optional(),
    inputCostPerMillion: z.number().nonnegative().optional(),
    outputCostPerMillion: z.number().nonnegative().optional(),
    maxContextTokens: z.number().int().positive().optional(),
  })
  .strict();
export async function loadProviders(
  dataDir: string,
): Promise<ProviderConfig[]> {
  try {
    const providers = z
      .array(providerSchema)
      .parse(await readJson(path.join(dataDir, "providers.json")));
    if (new Set(providers.map((p) => p.id)).size !== providers.length)
      throw new Error("Duplicate provider IDs");
    return providers;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export async function configureProvider(
  dataDir: string,
  provider: ProviderConfig,
): Promise<void> {
  const valid = providerSchema.parse(provider);
  const providers = await loadProviders(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeJson(path.join(dataDir, "providers.json"), [
    ...providers.filter((p) => p.id !== valid.id),
    valid,
  ]);
}
export async function projectExists(root: string): Promise<boolean> {
  try {
    await readFile(path.join(root, PROJECT_FILE));
    return true;
  } catch {
    return false;
  }
}
