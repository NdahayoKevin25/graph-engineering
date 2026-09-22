import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  canPromote,
  decide,
  evaluateDecisions,
  type EvaluationRow,
  type PromotionEvidence,
} from "../src/decisions.js";

const model = "pinned-test-model";
const row = (
  index: number,
  split: EvaluationRow["split"] = "held-out",
): EvaluationRow => ({
  split,
  caseId: `${split}-case-${index}`,
  taskId: `${split}-task-${index % 60}`,
  category: "worker",
  provider: "laya",
  model,
  selected: "local",
  expected: "local",
  confidence: 0.99,
  baselineSuccess: true,
  candidateSuccess: true,
  baselineCost: 1,
  candidateCost: 0.5,
  policyViolation: false,
});
const dataset = () => [
  ...Array.from({ length: 60 }, (_, index) => row(index, "calibration")),
  ...Array.from({ length: 240 }, (_, index) => row(index)),
];
const evidence = (): PromotionEvidence =>
  evaluateDecisions(dataset()).reports[0]!;
afterEach(() => vi.unstubAllGlobals());

describe("decision evaluation integrity (synthetic gate tests, not accuracy benchmarks)", () => {
  it("requires disjoint calibration and held-out data and counts task costs once", () => {
    const report = evidence();
    expect(report.heldOutCount).toBe(240);
    expect(report.taskCount).toBe(60);
    expect(report.calibrationCount).toBe(60);
    expect(report.baselineCost).toBe(60);
    expect(report.candidateCost).toBe(30);
    expect(canPromote(report)).toBe(true);
    const leaked = dataset();
    leaked[0]!.taskId = "held-out-task-0";
    expect(() => evaluateDecisions(leaked)).toThrow("disjoint");
    expect(() => evaluateDecisions([...dataset(), row(0)])).toThrow(
      "Duplicate",
    );
  });
  it("rejects invalid numeric evidence and uncalibrated confidence-one promotion", () => {
    const report = evidence();
    for (const invalid of [
      { candidateCost: -1 },
      { calibrationError: -0.1 },
      { heldOutCount: Infinity },
      { taskCount: NaN },
      { baselineCost: Infinity },
      { calibrationCount: 0 },
      { minimumConfidence: 1.1 },
    ])
      expect(canPromote({ ...report, ...invalid })).toBe(false);
    const onlyHeld = Array.from({ length: 240 }, (_, index) => ({
      ...row(index),
      confidence: 1,
    }));
    const uncalibrated = evaluateDecisions(onlyHeld).reports[0]!;
    expect(uncalibrated.calibrationCount).toBe(0);
    expect(canPromote(uncalibrated)).toBe(false);
    expect(() => evaluateDecisions([{ ...row(1), confidence: NaN }])).toThrow();
  });
  it("does not cancel calibration errors in opposite confidence bins", () => {
    const data = dataset();
    for (let index = 60; index < data.length; index++) {
      const item = data[index]!;
      if (index < 180) item.confidence = 0.5;
      else {
        item.confidence = 1;
        item.expected = index % 2 ? "frontier" : "local";
      }
    }
    const report = evaluateDecisions(data).reports[0]!;
    expect(report.calibrationError).toBeCloseTo(0.5);
    expect(canPromote(report)).toBe(false);
  });
  it("fails promotion for extra failures, policy violations, inconsistent costs, or insufficient accepted tasks", () => {
    const data = dataset();
    data[60]!.policyViolation = true;
    expect(canPromote(evaluateDecisions(data).reports[0]!)).toBe(false);
    const inconsistent = dataset();
    inconsistent[60]!.candidateCost = 99;
    expect(() => evaluateDecisions(inconsistent)).toThrow("consistent");
    expect(canPromote({ ...evidence(), additionalFailures: 1 })).toBe(false);
    expect(canPromote({ ...evidence(), taskCount: 59 })).toBe(false);
  });
});

describe("bounded decision dispatch", () => {
  const options = () => ({
    projectId: "test-project",
    category: "worker",
    state: { task: "rename a variable" },
    candidates: { local: "simple tasks", frontier: "complex tasks" },
    baseline: "local",
    policy: { ...DEFAULT_POLICY, providers: ["laya"] },
    providers: [
      {
        id: "laya" as const,
        endpoint: "http://127.0.0.1:7337/v1/decide",
        model,
        maxStateChars: 1200,
      },
    ],
  });
  const answer = (overrides: object = {}) =>
    new Response(
      JSON.stringify({
        model,
        answers: {
          action: { choice: "frontier", confidence: 0.99, ...overrides },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  it("keeps shadow decisions advisory and normalizes confidence from probabilities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({ probabilities: { local: 0.4, frontier: 0.6 } }),
      ),
    );
    const records = await decide(options());
    expect(records[0]?.mode).toBe("shadow");
    expect(records[0]?.baseline).toBe("local");
    expect(records[0]?.confidence).toBe(0.6);
  });
  it("abstains on invalid choices/probabilities, oversized states, and offline Jev", async () => {
    const fetch = vi.fn(async () => answer({ choice: "not-allowed" }));
    vi.stubGlobal("fetch", fetch);
    expect((await decide(options()))[0]?.selected).toBeNull();
    fetch.mockImplementation(async () =>
      answer({ probabilities: { local: 0.5, frontier: 1.5 } }),
    );
    expect((await decide(options()))[0]?.selected).toBeNull();
    fetch.mockClear();
    const oversized = options();
    oversized.state.task = "x".repeat(2000);
    expect((await decide(oversized))[0]?.selected).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const offline = {
      ...options(),
      providers: [
        {
          id: "jev" as const,
          endpoint: "https://api.typesafe.ai/decide",
          model,
          maxStateChars: 1200,
        },
      ],
    };
    expect((await decide(offline))[0]?.selected).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires matching model identity, promotion evidence, and fitted confidence threshold", async () => {
    const fetch = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetch);
    const input = {
      ...options(),
      policy: {
        ...options().policy,
        decisionMode: "promoted" as const,
        promotedCategories: ["worker"],
      },
      evidence: [{ ...evidence(), minimumConfidence: 0.95 }],
    };
    expect((await decide(input))[0]).toEqual(
      expect.objectContaining({ mode: "promoted", selected: "frontier" }),
    );
    fetch.mockImplementation(async () => answer({ confidence: 0.8 }));
    expect((await decide(input))[0]?.selected).toBeNull();
    fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            model: "changed-model",
            answers: { action: { choice: "frontier", confidence: 1 } },
          }),
        ),
    );
    expect((await decide(input))[0]?.selected).toBeNull();
    fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            answers: { action: { choice: "frontier", confidence: 1 } },
          }),
        ),
    );
    expect((await decide(input))[0]?.selected).toBeNull();
    await expect(
      decide({ ...input, evidence: [{ ...evidence(), candidateCost: -5 }] }),
    ).rejects.toThrow();
  });
  it("does not spend an unmetered Jev call outside the configured cost ceiling", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const input = options();
    input.policy = {
      ...input.policy,
      inference: "allowlisted",
      network: "allowlisted",
      allowedHosts: ["api.typesafe.ai"],
      providers: ["jev"],
      maxCostUsd: 1,
    };
    input.providers = [
      {
        id: "jev",
        endpoint: "https://api.typesafe.ai/v1/systemone",
        model,
        maxStateChars: 1200,
      },
    ];
    const records = await decide(input);
    expect(records[0]?.selected).toBeNull();
    expect(records[0]?.evidence.failure).toContain("cost-capped");
    expect(fetch).not.toHaveBeenCalled();
  });
});
