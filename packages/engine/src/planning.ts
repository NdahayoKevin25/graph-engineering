import type {
  DecisionRecord,
  ProjectPolicy,
  ProviderConfig,
} from "@graph-engineering/contracts";
import {
  decide,
  type DecisionProvider,
  type PromotionEvidence,
} from "./decisions.js";

export const WORKFLOWS = {
  "bug-fix":
    "Reproduce from supplied evidence, locate the smallest causal change, preserve unrelated behavior, and add regression coverage.",
  feature:
    "Implement the stated acceptance criteria using existing project conventions and add focused tests.",
  refactor:
    "Preserve observable behavior and public contracts. Make the smallest coherent structural change and retain regression coverage.",
  investigate:
    "Investigate the supplied evidence. Request missing source explicitly. Do not invent facts or modify unrelated code.",
} as const;
export type Workflow = keyof typeof WORKFLOWS;

/** These are bounded routing choices, never permissions or replacements for required checks. */
export async function routePlan(options: {
  projectId: string;
  objective: string;
  provider: ProviderConfig;
  explicitEffort?: string;
  policy: ProjectPolicy;
  providers: DecisionProvider[];
  evidence: PromotionEvidence[];
}): Promise<{
  workflow: Workflow;
  effort?: string;
  contextBudgetTokens: number;
  records: DecisionRecord[];
}> {
  const { objective, provider, policy } = options;
  const baseline: Workflow = /\b(fix|bug|fail|regression)\b/i.test(objective)
    ? "bug-fix"
    : /\brefactor\b/i.test(objective)
      ? "refactor"
      : /\b(investigate|explain|find|inspect)\b/i.test(objective)
        ? "investigate"
        : "feature";
  const contextLimit = Math.max(
    1,
    Math.floor(
      Math.min(
        policy.maxContextTokens,
        provider.maxContextTokens ?? policy.maxContextTokens,
      ) * 0.7,
    ),
  );
  const budgets = [
    ...new Set(
      [2048, 4096, 8192, contextLimit].filter((value) => value <= contextLimit),
    ),
  ];
  const effort = options.explicitEffort ?? provider.defaultEffort;
  const specs = [
    { category: "workflow", candidates: { ...WORKFLOWS }, baseline },
    {
      category: "context-budget",
      candidates: Object.fromEntries(
        budgets.map((value) => [
          String(value),
          `At most ${value} conservatively estimated source-context tokens`,
        ]),
      ),
      baseline: String(contextLimit),
    },
    ...(!options.explicitEffort && provider.efforts?.length
      ? [
          {
            category: "effort",
            candidates: Object.fromEntries(
              ["default", ...provider.efforts].map((value) => [
                value,
                value === "default"
                  ? "Configured model default"
                  : `Supported effort: ${value}`,
              ]),
            ),
            baseline: effort ?? "default",
          },
        ]
      : []),
  ];
  const groups = await Promise.all(
    specs.map((spec) =>
      decide({
        ...options,
        ...spec,
        state: {
          objective: objective.slice(0, 800),
          model: provider.model,
          workerKind: provider.kind,
          maxContextTokens: contextLimit,
        },
      }),
    ),
  );
  const selected = (category: string, fallback: string) =>
    groups
      .flat()
      .find(
        (record) =>
          record.category === category &&
          record.mode === "promoted" &&
          record.selected,
      )?.selected ?? fallback;
  const selectedEffort = selected("effort", effort ?? "default");
  return {
    workflow: selected("workflow", baseline) as Workflow,
    effort: selectedEffort === "default" ? undefined : selectedEffort,
    contextBudgetTokens: Number(
      selected("context-budget", String(contextLimit)),
    ),
    records: groups.flat(),
  };
}
