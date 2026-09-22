import type {
  DecisionRecord,
  ProjectPolicy,
} from "@graph-engineering/contracts";
import { z } from "zod";
import path from "node:path";
import { assertEndpoint, containsSecret } from "./policy.js";
import { hash, id, now, readJson } from "./util.js";

export interface DecisionProvider {
  id: "laya" | "jev";
  endpoint: string;
  model: string;
  apiKeyEnv?: string;
  maxStateChars: number;
}
export interface PromotionEvidence {
  version: string;
  category: string;
  provider: string;
  model: string;
  calibrationCount: number;
  heldOutCount: number;
  taskCount: number;
  policyViolations: number;
  additionalFailures: number;
  baselineCost: number;
  candidateCost: number;
  calibrationError: number;
  minimumConfidence: number;
}
const labelSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f]+$/);
const countSchema = z.number().finite().int().nonnegative().max(1_000_000_000);
const costSchema = z.number().finite().nonnegative().max(1_000_000_000_000);
export const promotionEvidenceSchema = z
  .object({
    version: z.string().regex(/^[a-f0-9]{64}$/),
    category: labelSchema,
    provider: z.enum(["laya", "jev"]),
    model: labelSchema,
    calibrationCount: countSchema,
    heldOutCount: countSchema,
    taskCount: countSchema,
    policyViolations: countSchema,
    additionalFailures: countSchema,
    baselineCost: costSchema,
    candidateCost: costSchema,
    calibrationError: z.number().finite().min(0).max(1),
    minimumConfidence: z.number().finite().min(0.5).max(1),
  })
  .strict()
  .refine(
    (value) => value.taskCount <= value.heldOutCount,
    "Accepted task count exceeds accepted decisions",
  );
export function canPromote(e: PromotionEvidence): boolean {
  const valid = promotionEvidenceSchema.safeParse(e);
  if (!valid.success) return false;
  return (
    e.calibrationCount >= 50 &&
    e.heldOutCount >= 200 &&
    e.taskCount >= 60 &&
    e.policyViolations === 0 &&
    e.additionalFailures === 0 &&
    e.candidateCost < e.baselineCost &&
    e.calibrationError <= 0.05
  );
}
const providerSchema = z
  .object({
    id: z.enum(["laya", "jev"]),
    endpoint: z.string().url(),
    model: z.string().min(1),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    maxStateChars: z.number().int().min(64).max(100000),
  })
  .strict();
export async function decisionProviders(
  dataDir: string,
): Promise<DecisionProvider[]> {
  try {
    return z
      .array(providerSchema)
      .parse(await readJson(path.join(dataDir, "decisions.json")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export async function decide(options: {
  projectId: string;
  category: string;
  state: Record<string, unknown>;
  candidates: Record<string, string>;
  baseline: string;
  policy: ProjectPolicy;
  providers: DecisionProvider[];
  evidence?: PromotionEvidence[];
  signal?: AbortSignal;
}): Promise<DecisionRecord[]> {
  const { policy, candidates, baseline, category } = options;
  if (!Object.hasOwn(candidates, baseline))
    throw new Error(
      "Decision baseline must belong to the allowed candidate set",
    );
  const promotionEvidence = z
    .array(promotionEvidenceSchema)
    .parse(options.evidence ?? []);
  const state = JSON.stringify(options.state);
  if (containsSecret(state))
    throw new Error("Decision state contains a potential secret");
  const records: DecisionRecord[] = [];
  for (const provider of options.providers) {
    const evidence = promotionEvidence.find(
      (e) =>
        e.category === category &&
        e.provider === provider.id &&
        e.model === provider.model,
    );
    const promoted =
      policy.decisionMode === "promoted" &&
      policy.promotedCategories.includes(category) &&
      !!evidence &&
      canPromote(evidence);
    let selected: string | null = null,
      confidence: number | null = null,
      modelVersion = provider.model,
      failure: string | undefined;
    try {
      if (!policy.providers.includes(provider.id))
        throw new Error(`Decision provider ${provider.id} is not permitted`);
      assertEndpoint(provider.endpoint, policy, provider.id === "laya");
      if (
        provider.id === "jev" &&
        (policy.inference === "local" || policy.network === "deny")
      )
        throw new Error("Jev is disabled by offline policy");
      if (provider.id === "jev" && policy.maxCostUsd !== null)
        throw new Error(
          "Jev usage cannot be metered by this adapter; cost-capped projects use local decisions",
        );
      if (state.length > provider.maxStateChars)
        throw new Error(
          "Compact decision state exceeds the configured model limit; abstaining",
        );
      const key = provider.apiKeyEnv
        ? process.env[provider.apiKeyEnv]
        : undefined;
      if (provider.apiKeyEnv && !key)
        throw new Error(`Missing ${provider.apiKeyEnv}`);
      const response = await fetch(provider.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: provider.model,
          state,
          questions: {
            action: {
              type: "choice",
              instructions: `Choose the best permitted ${category} action from the evidence.`,
              criteria: candidates,
            },
          },
        }),
        signal: AbortSignal.any([
          options.signal ?? new AbortController().signal,
          AbortSignal.timeout(10000),
        ]),
      });
      if (!response.ok)
        throw new Error(`Decision provider HTTP ${response.status}`);
      const result = (await response.json()) as {
        model?: string;
        answers?: {
          action?: {
            choice?: string;
            confidence?: number;
            probabilities?: Record<string, number>;
          };
        };
      };
      const answer = result.answers?.action;
      if (!answer?.choice || !Object.hasOwn(candidates, answer.choice))
        throw new Error("Decision provider returned an invalid choice");
      selected = answer.choice;
      if (answer.probabilities) {
        const probabilities = answer.probabilities,
          keys = Object.keys(probabilities),
          values = Object.values(probabilities);
        if (
          keys.length !== Object.keys(candidates).length ||
          keys.some((key) => !Object.hasOwn(candidates, key)) ||
          values.some(
            (value) =>
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              value < 0 ||
              value > 1,
          ) ||
          Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.01
        )
          throw new Error("Decision provider returned invalid probabilities");
        confidence = probabilities[answer.choice];
      } else
        confidence =
          typeof answer.confidence === "number" &&
          Number.isFinite(answer.confidence) &&
          answer.confidence >= 0 &&
          answer.confidence <= 1
            ? answer.confidence
            : null;
      modelVersion = result.model ?? "unreported";
      if (
        promoted &&
        (modelVersion !== provider.model ||
          confidence === null ||
          confidence < evidence!.minimumConfidence)
      )
        selected = null;
    } catch (error) {
      selected = null;
      failure =
        error instanceof Error ? error.message : "Decision provider failed";
    }
    const record: DecisionRecord = {
      version: "1.0.0",
      id: id(),
      projectId: options.projectId,
      category,
      candidates: Object.keys(candidates),
      selected,
      baseline,
      provider: provider.id,
      modelVersion,
      policyVersion: hash(policy),
      confidence,
      mode: promoted ? "promoted" : "shadow",
      createdAt: now(),
      evidence: {
        stateHash: hash(state),
        promotionVersion: evidence?.version ?? null,
        ...(failure ? { failure } : {}),
      },
    };
    records.push(record);
    if (promoted && selected) break;
  }
  return records;
}

export interface EvaluationRow {
  split: "calibration" | "held-out";
  category: string;
  provider: string;
  model: string;
  selected: string | null;
  expected: string;
  confidence: number;
  caseId: string;
  taskId: string;
  baselineSuccess: boolean;
  candidateSuccess: boolean;
  baselineCost: number;
  candidateCost: number;
  policyViolation: boolean;
}
const evaluationRowSchema = z
  .object({
    split: z.enum(["calibration", "held-out"]),
    category: labelSchema,
    provider: z.enum(["laya", "jev"]),
    model: labelSchema,
    selected: labelSchema.nullable(),
    expected: labelSchema,
    confidence: z.number().finite().min(0).max(1),
    caseId: labelSchema,
    taskId: labelSchema,
    baselineSuccess: z.boolean(),
    candidateSuccess: z.boolean(),
    baselineCost: costSchema,
    candidateCost: costSchema,
    policyViolation: z.boolean(),
  })
  .strict();
export function evaluateDecisions(rows: EvaluationRow[]): {
  reports: PromotionEvidence[];
  sampleCount: number;
} {
  rows = z.array(evaluationRowSchema).min(1).max(1_000_000).parse(rows);
  const splits = new Map<string, string>(),
    observations = new Set<string>(),
    cases = new Map<string, string>();
  for (const row of rows) {
    const previousSplit = splits.get(row.taskId);
    if (previousSplit && previousSplit !== row.split)
      throw new Error("Calibration and held-out task IDs must be disjoint");
    splits.set(row.taskId, row.split);
    const observation = JSON.stringify([
      row.category,
      row.provider,
      row.model,
      row.caseId,
    ]);
    if (observations.has(observation))
      throw new Error("Duplicate decision case in an evaluation group");
    observations.add(observation);
    const caseKey = JSON.stringify([row.category, row.caseId]),
      identity = JSON.stringify([row.taskId, row.expected]);
    if (cases.has(caseKey) && cases.get(caseKey) !== identity)
      throw new Error(
        "A decision case has inconsistent task identity or expected label",
      );
    cases.set(caseKey, identity);
  }
  const reports: PromotionEvidence[] = [];
  for (const key of new Set(
    rows.map((r) => `${r.category}\0${r.provider}\0${r.model}`),
  )) {
    const group = rows.filter(
      (r) => `${r.category}\0${r.provider}\0${r.model}` === key,
    );
    const calibration = group.filter((r) => r.split === "calibration");
    const held = group.filter((r) => r.split === "held-out");
    const taskResults = new Map<string, EvaluationRow>();
    for (const row of held) {
      const previous = taskResults.get(row.taskId);
      if (
        previous &&
        (previous.baselineSuccess !== row.baselineSuccess ||
          previous.candidateSuccess !== row.candidateSuccess ||
          previous.baselineCost !== row.baselineCost ||
          previous.candidateCost !== row.candidateCost)
      )
        throw new Error(
          "End-to-end outcomes and costs must be consistent within a task",
        );
      taskResults.set(row.taskId, row);
    }
    const thresholds = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99];
    const fittedThreshold = thresholds.find((t) => {
      const selected = calibration.filter(
        (r) => r.confidence >= t && r.selected !== null,
      );
      return (
        selected.length >= 50 &&
        selected.filter((r) => r.selected === r.expected).length /
          selected.length >=
          0.95
      );
    });
    const threshold = fittedThreshold ?? 1;
    const calibrationCount =
      fittedThreshold === undefined
        ? 0
        : calibration.filter(
            (row) => row.selected !== null && row.confidence >= threshold,
          ).length;
    const accepted =
      fittedThreshold === undefined
        ? []
        : held.filter((r) => r.confidence >= threshold && r.selected !== null);
    let calibrationError = accepted.length ? 0 : 1;
    for (let bin = 0; bin < 10; bin++) {
      const items = accepted.filter(
        (row) => Math.min(9, Math.floor(row.confidence * 10)) === bin,
      );
      if (items.length)
        calibrationError +=
          (items.length / accepted.length) *
          Math.abs(
            items.reduce((sum, row) => sum + row.confidence, 0) / items.length -
              items.filter((row) => row.selected === row.expected).length /
                items.length,
          );
    }
    const taskIds = new Set(accepted.map((row) => row.taskId));
    const [category, provider, model] = key.split("\0");
    reports.push({
      version: hash(group),
      category,
      provider,
      model,
      calibrationCount,
      heldOutCount: accepted.length,
      taskCount: taskIds.size,
      policyViolations: new Set(
        held.filter((r) => r.policyViolation).map((row) => row.taskId),
      ).size,
      additionalFailures: [...taskResults.values()].filter(
        (r) => r.baselineSuccess && !r.candidateSuccess,
      ).length,
      baselineCost: [...taskResults.values()].reduce(
        (s, r) => s + r.baselineCost,
        0,
      ),
      candidateCost: [...taskResults.values()].reduce(
        (s, r) => s + r.candidateCost,
        0,
      ),
      calibrationError,
      minimumConfidence: threshold,
    });
  }
  return { reports, sampleCount: rows.length };
}
