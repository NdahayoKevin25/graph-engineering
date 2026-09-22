import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const SCHEMA_VERSION = "1.0.0" as const;
export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "text";
export type MemoryKind =
  "observation" | "decision" | "requirement" | "constraint" | "solution";
export type ProviderKind =
  "local" | "openai" | "anthropic" | "codex" | "claude" | "cursor";
export type RunStatus =
  | "planned"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "needs_reconciliation";

export interface ProjectPolicy {
  version: typeof SCHEMA_VERSION;
  inference: "local" | "allowlisted";
  providers: string[];
  network: "deny" | "allowlisted";
  allowedHosts: string[];
  exportPaths: string[];
  excludedPaths: string[];
  publication: "none" | "commit" | "draft-pr";
  maxWorkers: number;
  maxAttempts: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  maxTurns: number;
  timeoutSeconds: number;
  maxCostUsd: number | null;
  decisionMode: "shadow" | "promoted";
  promotedCategories: string[];
}
export const DEFAULT_POLICY: ProjectPolicy = {
  version: SCHEMA_VERSION,
  inference: "local",
  providers: [],
  network: "deny",
  allowedHosts: [],
  exportPaths: [],
  excludedPaths: [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "**/credentials*",
    "**/secrets*",
  ],
  publication: "none",
  maxWorkers: 2,
  maxAttempts: 3,
  maxContextTokens: 16000,
  maxOutputTokens: 4000,
  maxTurns: 12,
  timeoutSeconds: 600,
  maxCostUsd: null,
  decisionMode: "shadow",
  promotedCategories: [],
};
export interface ProjectConfig {
  version: typeof SCHEMA_VERSION;
  projectId: string;
  name: string;
  policy: ProjectPolicy;
  verification: { argv: string[]; image: string }[];
  github?: { repository: string; baseBranch: string; remote: string };
}
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  model: string;
  endpoint?: string;
  apiKeyEnv?: string;
  efforts?: string[];
  defaultEffort?: string;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  maxContextTokens?: number;
}
export interface RepositorySnapshot {
  version: typeof SCHEMA_VERSION;
  id: string;
  projectId: string;
  worktreeId: string;
  revision: string | null;
  contentHash: string;
  createdAt: string;
  fileCount: number;
  languages: string[];
  coverage: { parsed: number; textOnly: number; errors: string[] };
}
export interface SourceReference {
  path: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  snapshotId: string;
}
export interface CodeSymbol {
  id: string;
  name: string;
  kind: string;
  language: Language;
  source: SourceReference;
  signature: string;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string | null;
  target: string;
  kind: "imports" | "calls" | "references" | "contains";
  evidence: "syntactic" | "resolved" | "heuristic";
  source: SourceReference;
}
export interface ContextItem {
  id: string;
  kind: "code" | "memory" | "document";
  text: string;
  score: number;
  source?: SourceReference;
  memoryId?: string;
}
export interface ContextPacket {
  version: typeof SCHEMA_VERSION;
  projectId: string;
  snapshotId: string;
  query: string;
  mandatory: string[];
  mandatorySources?: {
    text: string;
    visibility: "private" | "shared";
    sources: SourceReference[];
  }[];
  items: ContextItem[];
  estimatedTokens: number;
  budgetTokens: number;
  coverage: { semantic: boolean; graph: string; warnings: string[] };
}
export interface MemoryRecord {
  version: typeof SCHEMA_VERSION;
  id: string;
  projectId: string;
  kind: MemoryKind;
  text: string;
  visibility: "private" | "shared";
  status: "proposed" | "accepted" | "superseded" | "conflicted";
  createdAt: string;
  sources: SourceReference[];
  supersedes?: string;
}
export interface ExecutionStep {
  id: string;
  kind: "worker" | "template";
  objective: string;
  dependsOn: string[];
  providerId?: string;
  effort?: string;
  templateId?: string;
  inputs?: Record<string, unknown>;
}
export interface ExecutionPlan {
  version: typeof SCHEMA_VERSION;
  id: string;
  projectId: string;
  snapshotId: string;
  policyHash: string;
  createdAt: string;
  objective: string;
  acceptance: string[];
  steps: ExecutionStep[];
  verification: ProjectConfig["verification"];
  publication: ProjectPolicy["publication"];
  routing?: {
    workflow: string;
    contextBudgetTokens: number;
    decisionIds: string[];
  };
}
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  estimated: boolean;
}
export interface RunEvent {
  version: typeof SCHEMA_VERSION;
  id: string;
  runId: string;
  projectId: string;
  at: string;
  type: string;
  stepId?: string;
  data: Record<string, unknown>;
}
export interface RunRecord {
  id: string;
  plan: ExecutionPlan;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  workspace?: string;
  branch?: string;
  error?: string;
  usage: Usage;
  commit?: string;
  pullRequest?: string;
}
export interface DecisionRecord {
  version: typeof SCHEMA_VERSION;
  id: string;
  projectId: string;
  category: string;
  candidates: string[];
  selected: string | null;
  baseline: string;
  provider: string;
  modelVersion: string;
  policyVersion: string;
  confidence: number | null;
  mode: "shadow" | "promoted";
  createdAt: string;
  evidence: Record<string, unknown>;
}

const nonempty = { type: "string", minLength: 1 };
const strings = { type: "array", items: nonempty, uniqueItems: true };
export const policySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: Object.keys(DEFAULT_POLICY),
  properties: {
    version: { const: SCHEMA_VERSION },
    inference: { enum: ["local", "allowlisted"] },
    providers: strings,
    network: { enum: ["deny", "allowlisted"] },
    allowedHosts: strings,
    exportPaths: strings,
    excludedPaths: strings,
    publication: { enum: ["none", "commit", "draft-pr"] },
    maxWorkers: { type: "integer", minimum: 1, maximum: 8 },
    maxAttempts: { type: "integer", minimum: 1, maximum: 10 },
    maxContextTokens: { type: "integer", minimum: 256, maximum: 1000000 },
    maxOutputTokens: { type: "integer", minimum: 64, maximum: 128000 },
    maxTurns: { type: "integer", minimum: 1, maximum: 100 },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 86400 },
    maxCostUsd: {
      anyOf: [{ type: "null" }, { type: "number", exclusiveMinimum: 0 }],
    },
    decisionMode: { enum: ["shadow", "promoted"] },
    promotedCategories: strings,
  },
};
export const projectSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["version", "projectId", "name", "policy", "verification"],
  properties: {
    version: { const: SCHEMA_VERSION },
    projectId: { type: "string", pattern: "^[a-zA-Z0-9_-]{8,80}$" },
    name: nonempty,
    policy: policySchema,
    verification: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["argv", "image"],
        properties: {
          argv: { type: "array", minItems: 1, items: nonempty },
          image: nonempty,
        },
      },
    },
    github: {
      type: "object",
      additionalProperties: false,
      required: ["repository", "baseBranch", "remote"],
      properties: {
        repository: {
          type: "string",
          pattern: "^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$",
        },
        baseBranch: nonempty,
        remote: nonempty,
      },
    },
  },
};
const Ajv = Ajv2020 as unknown as typeof import("ajv").default;
const ajv = new Ajv({ allErrors: true, strict: false });
(addFormats as unknown as (a: typeof ajv) => void)(ajv);
const validateProject = ajv.compile(projectSchema);
export function assertProjectConfig(
  value: unknown,
): asserts value is ProjectConfig {
  if (!validateProject(value))
    throw new Error(
      `Invalid project configuration: ${ajv.errorsText(validateProject.errors)}`,
    );
}
