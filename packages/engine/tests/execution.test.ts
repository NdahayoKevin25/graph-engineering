import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_POLICY,
  type ProjectConfig,
} from "@graph-engineering/contracts";
import {
  initializeProject,
  configureProvider,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { GraphEngine } from "../src/service.js";
import { applyProposal } from "../src/execution/workspace.js";
import { checked, writeJson } from "../src/util.js";
import { RunStore } from "../src/store.js";

const roots: string[] = [];
const engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-execution-"));
  roots.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "core.autocrlf", "false"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await writeFile(
    path.join(root, "math.cjs"),
    "exports.add = (a, b) => a - b;\n",
  );
  await writeFile(
    path.join(root, "math.test.cjs"),
    "const assert = require('node:assert/strict'); const {add} = require('./math.cjs'); assert.equal(add(2, 3), 5);\n",
  );
  const config = await initializeProject(root);
  config.policy.providers = ["local"];
  config.verification = [
    { image: "node:24-alpine", argv: ["node", "--test", "math.test.cjs"] },
  ];
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: initial fixture"], {
    cwd: root,
  });
  const data = projectDataDir(config.projectId);
  roots.push(data);
  await configureProvider(data, {
    id: "local",
    kind: "local",
    model: "fixture",
    endpoint: "http://127.0.0.1:11434/v1",
  });
  return { root, config, data };
}
describe("managed execution", () => {
  it("validates a whole patch before changing any file", async () => {
    const { root } = await fixture();
    await expect(
      applyProposal(
        root,
        {
          summary: "bad",
          requests: [],
          changes: [
            { path: "math.cjs", before: "a - b", after: "a + b" },
            { path: "missing.ts", before: "missing", after: "new" },
          ],
        },
        DEFAULT_POLICY,
      ),
    ).rejects.toThrow("precondition");
    expect(await readFile(path.join(root, "math.cjs"), "utf8")).toContain(
      "a - b",
    );
    await expect(
      applyProposal(
        root,
        {
          summary: "bad",
          requests: [],
          changes: [{ path: ".graph/project.json", before: null, after: "{}" }],
        },
        DEFAULT_POLICY,
      ),
    ).rejects.toThrow("scope");
  });
  it("retains the original worktree and persists independent verification evidence", async () => {
    const { root } = await fixture();
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async () => ({
        model: "fixture",
        proposal: {
          summary: "Fix addition",
          requests: [],
          changes: [{ path: "math.cjs", before: "a - b", after: "a + b" }],
        },
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          cachedTokens: 0,
          costUsd: 0,
          estimated: false,
        },
      }),
      verify: async (workspace, checks, _policy, snapshotHash) => {
        expect(
          await readFile(path.join(workspace, "math.cjs"), "utf8"),
        ).toContain("a + b");
        return checks.map((check) => ({
          ...check,
          code: 0,
          stdout: "test passed",
          stderr: "",
          snapshotHash,
        }));
      },
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["2 + 3 is 5"],
    });
    const run = await engine.start(plan.id);
    const result = await engine.wait(run.id);
    expect(result.status).toBe("succeeded");
    expect(result.usage.inputTokens).toBe(10);
    expect(await readFile(path.join(root, "math.cjs"), "utf8")).toContain(
      "a - b",
    );
    expect(
      engine.store
        .events(run.id)
        .some((e) => e.type === "verification.completed"),
    ).toBe(true);
    expect(
      engine.store.events(run.id).filter((e) => e.type === "worker.dispatched"),
    ).toHaveLength(1);
  });
  it("does not let an optimistic worker override a failed check", async () => {
    const { root } = await fixture();
    const config = JSON.parse(
      await readFile(path.join(root, PROJECT_FILE), "utf8"),
    ) as ProjectConfig;
    config.policy.maxAttempts = 1;
    await writeJson(path.join(root, PROJECT_FILE), config);
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async () => ({
        model: "fixture",
        proposal: { summary: "Everything passed", requests: [], changes: [] },
        usage: {
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          costUsd: null,
          estimated: false,
        },
      }),
      verify: async (_workspace, checks, _policy, snapshotHash) =>
        checks.map((check) => ({
          ...check,
          code: 1,
          stdout: "",
          stderr: "assertion failed",
          snapshotHash,
        })),
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["tests pass"],
    });
    const run = await engine.start(plan.id);
    expect((await engine.wait(run.id)).status).toBe("failed");
    expect(engine.store.run(run.id).usage.inputTokens).toBeNull();
  });
  it("rejects source and policy changes between planning and dispatch", async () => {
    const { root } = await fixture();
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["tests pass"],
    });
    await writeFile(path.join(root, "math.cjs"), "// user changed source\n");
    await expect(engine.start(plan.id)).rejects.toThrow("Source changed");
    const fresh = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["tests pass"],
    });
    const config = await initializeProject(root);
    config.policy.maxAttempts = 1;
    await writeJson(path.join(root, PROJECT_FILE), config);
    await expect(engine.start(fresh.id)).rejects.toThrow("Policy changed");
  });
  it("does not mark a live process interrupted when another client opens its store", async () => {
    const { root, data, config } = await fixture();
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async (input) => {
        await new Promise<void>((_resolve, reject) =>
          input.signal?.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          ),
        );
        throw new Error("unreachable");
      },
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["tests pass"],
    });
    const run = await engine.start(plan.id);
    const other = new RunStore(data, config.projectId);
    other.recoverInterrupted();
    expect(other.run(run.id).status).not.toBe("needs_reconciliation");
    other.close();
    engine.cancel(run.id);
    expect((await engine.wait(run.id)).status).toBe("cancelled");
  });
  it("re-verifies a retained patch on resume without replaying the worker", async () => {
    const { root } = await fixture();
    let calls = 0,
      checks = 0;
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async () => {
        calls++;
        return {
          model: "fixture",
          proposal: {
            summary: "Fix addition",
            requests: [],
            changes: [{ path: "math.cjs", before: "a - b", after: "a + b" }],
          },
          usage: {
            inputTokens: 10,
            outputTokens: 10,
            cachedTokens: 0,
            costUsd: 0,
            estimated: false,
          },
        };
      },
      verify: async (_workspace, commands, _policy, snapshotHash) => {
        if (++checks === 1)
          throw new Error("Verification temporarily unavailable");
        return commands.map((check) => ({
          ...check,
          code: 0,
          stdout: "passed",
          stderr: "",
          snapshotHash,
        }));
      },
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["addition passes"],
    });
    const run = await engine.start(plan.id);
    expect((await engine.wait(run.id)).status).toBe("failed");
    await expect(engine.resume(run.id)).rejects.toThrow("reconciliation");
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.status).toBe("succeeded");
    expect(resumed.error).toBeUndefined();
    expect(calls).toBe(1);
    expect(checks).toBe(2);
    expect(
      engine.store
        .events(run.id)
        .some((event) => event.type === "step.reconciled"),
    ).toBe(true);
  });
  it("reserves resumed runs transactionally across independent clients", async () => {
    const { root, data, config } = await fixture();
    const engine = await GraphEngine.open(root);
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["passes"],
    });
    const timestamp = new Date().toISOString();
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      estimated: true,
    };
    engine.store.saveRun({
      id: "failed-one",
      plan,
      status: "failed",
      createdAt: timestamp,
      updatedAt: timestamp,
      usage,
    });
    engine.store.saveRun({
      id: "failed-two",
      plan,
      status: "failed",
      createdAt: timestamp,
      updatedAt: timestamp,
      usage,
    });
    const other = new RunStore(data, config.projectId);
    try {
      engine.store.reserveResume("failed-one", 1);
      expect(() => other.reserveResume("failed-one", 1)).toThrow("resumption");
      expect(() => other.reserveResume("failed-two", 1)).toThrow("concurrency");
      expect(other.run("failed-two").status).toBe("failed");
    } finally {
      other.close();
    }
  });
  it("does not export private source or filenames from verification logs", async () => {
    const { root, config, data } = await fixture();
    config.policy = {
      ...config.policy,
      inference: "allowlisted",
      network: "allowlisted",
      allowedHosts: ["api.openai.com"],
      providers: ["cloud"],
      exportPaths: ["math.cjs"],
      maxAttempts: 2,
    };
    await writeJson(path.join(root, PROJECT_FILE), config);
    await configureProvider(data, {
      id: "cloud",
      kind: "openai",
      model: "fixture",
    });
    let workers = 0,
      checks = 0;
    const canary = "private/payroll-canary.ts: private customer business data";
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async (input) => {
        if (++workers === 2) {
          expect(input.feedback).toContain("Required verification failed");
          expect(input.feedback).not.toContain(canary);
          expect(input.feedback).not.toContain("payroll");
        }
        return {
          model: "fixture",
          proposal: { summary: "proposal", requests: [], changes: [] },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedTokens: 0,
            costUsd: 0,
            estimated: false,
          },
        };
      },
      verify: async (_workspace, commands, _policy, snapshotHash) =>
        commands.map((check) => ({
          ...check,
          code: ++checks === 1 ? 1 : 0,
          stdout: canary,
          stderr: canary,
          snapshotHash,
        })),
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["passes"],
    });
    const run = await engine.start(plan.id);
    expect((await engine.wait(run.id)).status).toBe("succeeded");
    expect(workers).toBe(2);
  });
  it("allows repeated close notifications", async () => {
    const { root } = await fixture();
    const engine = await GraphEngine.open(root);
    engines.push(engine);
    await Promise.all([engine.close(), engine.close()]);
    await expect(engine.close()).resolves.toBeUndefined();
  });
  it.runIf(process.env.GRAPH_ENGINE_DOCKER_TESTS === "1")(
    "executes real offline Docker verification on an isolated source view",
    async () => {
      const { root } = await fixture();
      const engine = await GraphEngine.open(root, {
        worker: async () => ({
          model: "fixture",
          proposal: {
            summary: "Fix addition",
            requests: [],
            changes: [{ path: "math.cjs", before: "a - b", after: "a + b" }],
          },
          usage: {
            inputTokens: 10,
            outputTokens: 10,
            cachedTokens: 0,
            costUsd: 0,
            estimated: false,
          },
        }),
      });
      engines.push(engine);
      const plan = await engine.createPlan({
        objective: "Fix addition",
        acceptance: ["node test succeeds"],
      });
      const run = await engine.start(plan.id);
      const result = await engine.wait(run.id);
      expect(
        result.error,
        JSON.stringify(engine.store.events(run.id)),
      ).toBeUndefined();
      expect(result.status).toBe("succeeded");
    },
  );
});
