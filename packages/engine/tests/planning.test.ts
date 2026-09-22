import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { routePlan } from "../src/planning.js";

describe("bounded routing", () => {
  it("uses deterministic defaults without model calls and preserves an explicit effort", async () => {
    const result = await routePlan({
      projectId: "test",
      objective: "Fix the failing addition test",
      provider: {
        id: "local",
        kind: "local",
        model: "test",
        efforts: ["low", "high"],
        defaultEffort: "low",
      },
      explicitEffort: "high",
      policy: DEFAULT_POLICY,
      providers: [],
      evidence: [],
    });
    expect(result).toEqual({
      workflow: "bug-fix",
      effort: "high",
      contextBudgetTokens: 11200,
      records: [],
    });
  });
  it("never allocates more than the provider context limit", async () => {
    const result = await routePlan({
      projectId: "test",
      objective: "Refactor the helper",
      provider: {
        id: "local",
        kind: "local",
        model: "test",
        maxContextTokens: 2048,
      },
      policy: DEFAULT_POLICY,
      providers: [],
      evidence: [],
    });
    expect(result.workflow).toBe("refactor");
    expect(result.contextBudgetTokens).toBe(1433);
  });
});
