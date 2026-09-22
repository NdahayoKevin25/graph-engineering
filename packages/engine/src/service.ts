import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ContextPacket,
  ExecutionPlan,
  ProjectConfig,
  ProviderConfig,
  RunRecord,
  Usage,
} from "@graph-engineering/contracts";
import { ContextEngine } from "./context/index.js";
import { loadProject, loadProviders, projectDataDir } from "./project.js";
import { RunStore } from "./store.js";
import {
  assertProvider,
  contextForProvider,
  isAllowedPath,
  redact,
  safePath,
} from "./policy.js";
import { errorMessage, hash, id, now, readJson } from "./util.js";
import {
  decide,
  decisionProviders,
  type PromotionEvidence,
} from "./decisions.js";
import {
  invokeApiWorker,
  estimateRequestCost,
  type WorkerInput,
  type WorkerResult,
} from "./workers/api.js";
import {
  invokeInstalledWorker,
  discoverInstalledWorkers,
} from "./workers/installed.js";
import {
  applyProposal,
  createWorkspace,
  workspaceFingerprint,
} from "./execution/workspace.js";
import {
  dockerAvailable,
  verifyInContainer,
  type VerificationResult,
} from "./execution/docker.js";
import { publishRun } from "./execution/publish.js";
import { checkedGit } from "./execution/git.js";
import { routePlan, WORKFLOWS } from "./planning.js";

export interface EngineDependencies {
  worker?: (input: WorkerInput, workspace: string) => Promise<WorkerResult>;
  verify?: typeof verifyInContainer;
  dockerAvailable?: typeof dockerAvailable;
}
const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
  estimated: true,
});
function sumUsage(a: Usage, b: Usage): Usage {
  const sum = (x: number | null, y: number | null) =>
    x === null || y === null ? null : x + y;
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    cachedTokens: sum(a.cachedTokens, b.cachedTokens),
    costUsd: sum(a.costUsd, b.costUsd),
    estimated: a.estimated || b.estimated,
  };
}
export class GraphEngine {
  readonly context: ContextEngine;
  readonly store: RunStore;
  readonly dataDir: string;
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private closing?: Promise<void>;
  private constructor(
    readonly root: string,
    public config: ProjectConfig,
    private deps: EngineDependencies,
  ) {
    this.dataDir = projectDataDir(config.projectId);
    this.context = new ContextEngine({
      projectId: config.projectId,
      root,
      dataDir: this.dataDir,
      policy: config.policy,
    });
    this.store = new RunStore(this.dataDir, config.projectId);
    this.store.recoverInterrupted();
  }
  static async open(
    root: string,
    deps: EngineDependencies = {},
  ): Promise<GraphEngine> {
    const absolute = path.resolve(root);
    return new GraphEngine(absolute, await loadProject(absolute), deps);
  }
  async providers(): Promise<ProviderConfig[]> {
    return loadProviders(this.dataDir);
  }
  async refresh(): Promise<ProjectConfig> {
    const config = await loadProject(this.root);
    if (config.projectId !== this.config.projectId)
      throw new Error("Project identity changed; restart the engine");
    Object.assign(this.config.policy, config.policy);
    this.config = { ...config, policy: this.config.policy };
    this.context.updatePolicy(config.policy);
    return this.config;
  }
  async createPlan(input: {
    objective: string;
    acceptance: string[];
    providerId?: string;
    effort?: string;
  }): Promise<ExecutionPlan> {
    await this.refresh();
    if (
      !input.objective.trim() ||
      input.acceptance.length === 0 ||
      input.acceptance.some((a) => !a.trim())
    )
      throw new Error(
        "An objective and explicit acceptance criteria are required",
      );
    const snapshot = await this.context.index();
    const configured = await this.providers();
    const installed = configured.some((p) =>
      ["codex", "claude", "cursor"].includes(p.kind),
    )
      ? await discoverInstalledWorkers()
      : [];
    const available = configured.filter((p) => {
      try {
        assertProvider(p, this.config.policy);
        return (
          !["codex", "claude", "cursor"].includes(p.kind) ||
          installed.some(
            (capability) => capability.kind === p.kind && capability.available,
          )
        );
      } catch {
        return false;
      }
    });
    if (!available.length)
      throw new Error(
        "No permitted worker is configured. Add a local provider or explicitly enable a cloud provider in project policy.",
      );
    let provider = input.providerId
      ? available.find((p) => p.id === input.providerId)
      : available[0];
    if (!provider)
      throw new Error("Selected worker is unavailable under project policy");
    if (!input.providerId) {
      let evidence: PromotionEvidence[] = [];
      try {
        evidence = await readJson(path.join(this.dataDir, "promotions.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const records = await decide({
        projectId: this.config.projectId,
        category: "worker",
        state: {
          objective: input.objective.slice(0, 800),
          languages: snapshot.languages,
          fileCount: snapshot.fileCount,
        },
        candidates: Object.fromEntries(
          available.map((p) => [p.id, `${p.kind} ${p.model}`]),
        ),
        baseline: provider.id,
        policy: this.config.policy,
        providers: await decisionProviders(this.dataDir),
        evidence,
      });
      records.forEach((record) => this.store.decision(record));
      const selected = records.find(
        (r) => r.mode === "promoted" && r.selected,
      )?.selected;
      if (selected) provider = available.find((p) => p.id === selected)!;
    }
    assertProvider(provider, this.config.policy, input.effort);
    let routingEvidence: PromotionEvidence[] = [];
    try {
      routingEvidence = await readJson(
        path.join(this.dataDir, "promotions.json"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const routing = await routePlan({
      projectId: this.config.projectId,
      objective: input.objective,
      provider,
      explicitEffort: input.effort,
      policy: this.config.policy,
      providers: await decisionProviders(this.dataDir),
      evidence: routingEvidence,
    });
    routing.records.forEach((record) => this.store.decision(record));
    assertProvider(provider, this.config.policy, routing.effort);
    const plan: ExecutionPlan = {
      version: "1.0.0",
      id: id(),
      projectId: this.config.projectId,
      snapshotId: snapshot.id,
      policyHash: hash(this.config.policy),
      createdAt: now(),
      objective: input.objective,
      acceptance: input.acceptance,
      steps: [
        {
          id: "implement",
          kind: "worker",
          objective: `${input.objective}\n\nWorkflow: ${WORKFLOWS[routing.workflow]}`,
          dependsOn: [],
          providerId: provider.id,
          effort: routing.effort,
        },
      ],
      routing: {
        workflow: routing.workflow,
        contextBudgetTokens: routing.contextBudgetTokens,
        decisionIds: routing.records.map((record) => record.id),
      },
      verification: structuredClone(this.config.verification),
      publication: this.config.policy.publication,
    };
    this.store.savePlan(plan);
    return plan;
  }
  async start(planId: string): Promise<RunRecord> {
    await this.refresh();
    const plan = this.store.plan(planId);
    if (plan.policyHash !== hash(this.config.policy))
      throw new Error("Policy changed since planning; create a new plan");
    if (this.active.size >= this.config.policy.maxWorkers)
      throw new Error("Project concurrency limit reached");
    if (plan.verification.length === 0)
      throw new Error("Configure verification commands before running work");
    if (!(await (this.deps.dockerAvailable ?? dockerAvailable)()))
      throw new Error("A running Docker-compatible engine is required");
    const snapshot = await this.context.index();
    if (snapshot.id !== plan.snapshotId)
      throw new Error("Source changed since planning; create a fresh plan");
    if (
      plan.publication !== "none" &&
      (await checkedGit(this.root, ["status", "--porcelain"]))
    )
      throw new Error(
        "Commit your existing changes before a run that publishes; unrelated local work must not enter its commit",
      );
    const run: RunRecord = {
      id: id(),
      plan,
      status: "planned",
      createdAt: now(),
      updatedAt: now(),
      usage: emptyUsage(),
    };
    this.store.reserve(run, this.config.policy.maxWorkers);
    this.launch(run);
    return this.store.run(run.id);
  }
  private launch(run: RunRecord, resuming = false): void {
    const controller = new AbortController();
    const initialEvents = this.store.events(run.id).length;
    this.store.claim(run.id);
    const timer = setInterval(() => {
      if (
        this.store
          .events(run.id)
          .slice(initialEvents)
          .some((e) => e.type === "cancel.requested")
      )
        controller.abort();
    }, 500);
    const promise = this.execute(run, controller.signal, resuming).finally(
      () => {
        clearInterval(timer);
        this.active.delete(run.id);
      },
    );
    this.active.set(run.id, { controller, promise });
  }
  async wait(runId: string): Promise<RunRecord> {
    await this.active.get(runId)?.promise;
    return this.store.run(runId);
  }
  cancel(runId: string): RunRecord {
    const run = this.store.run(runId);
    if (!["planned", "running", "verifying"].includes(run.status))
      throw new Error("Run is not active");
    this.active.get(runId)?.controller.abort();
    this.store.event(runId, "cancel.requested", {});
    return this.store.run(runId);
  }
  async resume(runId: string, reconciled = false): Promise<RunRecord> {
    if (this.active.has(runId)) throw new Error("Run is already active");
    const run = this.store.run(runId);
    if (!["failed", "cancelled", "needs_reconciliation"].includes(run.status))
      throw new Error("Run does not need resumption");
    if (!reconciled)
      throw new Error(
        "Inspect the retained workspace and events, then resume with explicit reconciliation acknowledgement",
      );
    await this.refresh();
    if (hash(this.config.policy) !== run.plan.policyHash)
      throw new Error("Policy changed; create a fresh plan");
    if (this.active.size >= this.config.policy.maxWorkers)
      throw new Error("Project concurrency limit reached");
    if (run.plan.verification.length === 0)
      throw new Error("Configure verification commands before running work");
    if (!(await (this.deps.dockerAvailable ?? dockerAvailable)()))
      throw new Error("A running Docker-compatible engine is required");
    if (
      !run.workspace &&
      (await this.context.index()).id !== run.plan.snapshotId
    )
      throw new Error(
        "Source changed before workspace creation; create a fresh plan",
      );
    const reserved = this.store.reserveResume(
      runId,
      this.config.policy.maxWorkers,
    );
    this.store.event(runId, "recovery.acknowledged", {});
    this.launch(reserved, true);
    return this.store.run(runId);
  }
  private async execute(
    run: RunRecord,
    signal: AbortSignal,
    resuming = false,
  ): Promise<void> {
    const save = (status: RunRecord["status"]) => {
      run.status = status;
      run.updatedAt = now();
      this.store.saveRun(run);
    };
    try {
      const priorEvents = this.store.events(run.id);
      delete run.error;
      save("running");
      this.store.event(run.id, "run.started", { resuming });
      if (!run.workspace) {
        Object.assign(
          run,
          await createWorkspace(
            this.root,
            this.dataDir,
            run.id,
            this.config.policy,
          ),
        );
        save("running");
      }
      const workspace = run.workspace!;
      const budgetTokens =
        run.plan.routing?.contextBudgetTokens ??
        Math.floor(this.config.policy.maxContextTokens * 0.7);
      const originalPacket = await this.context.getContext({
        query: run.plan.objective,
        snapshotId: run.plan.snapshotId,
        budgetTokens,
        mandatory: run.plan.acceptance,
      });
      const currentContext = async () => {
        const latest = new ContextEngine({
          projectId: this.config.projectId,
          root: workspace,
          dataDir: path.join(this.dataDir, "run-context", run.id),
          policy: this.config.policy,
        });
        try {
          await latest.index();
          const current = await latest.getContext({
            query: run.plan.objective,
            budgetTokens,
            mandatory: originalPacket.mandatory,
          });
          return {
            ...current,
            mandatorySources: originalPacket.mandatorySources,
          };
        } finally {
          await latest.close();
        }
      };
      const packet = resuming ? await currentContext() : originalPacket;
      let feedback = "";
      let verified = false;
      let verifiedHash: string | undefined;
      const verify = async (stepId: string) => {
        if (signal.aborted) throw new Error("Run cancelled");
        save("verifying");
        const before = await workspaceFingerprint(
          workspace,
          this.config.policy,
        );
        this.store.event(
          run.id,
          "verification.started",
          { snapshotHash: before },
          stepId,
        );
        const checks = await (this.deps.verify ?? verifyInContainer)(
          workspace,
          run.plan.verification,
          this.config.policy,
          before,
          signal,
        );
        const after = await workspaceFingerprint(workspace, this.config.policy);
        this.store.event(
          run.id,
          "verification.completed",
          {
            checks: checks.map((c) => ({
              ...c,
              stdout: redact(c.stdout).slice(-16000),
              stderr: redact(c.stderr).slice(-16000),
            })),
            snapshotHash: after,
          },
          stepId,
        );
        if (before !== after)
          throw new Error(
            "Verification modified project source; review the retained workspace before retrying",
          );
        verified =
          checks.length === run.plan.verification.length &&
          checks.every((c) => c.code === 0);
        verifiedHash = verified ? after : undefined;
        feedback = compactFailures(checks);
        return verified;
      };
      for (const step of run.plan.steps) {
        verified = false;
        // An acknowledged recovery checks the retained patch first. It never
        // reapplies the original exact-substring patch to an already edited file.
        if (
          resuming &&
          priorEvents.some(
            (event) =>
              event.type === "publication.started" ||
              (event.type === "patch.applied" && event.stepId === step.id),
          )
        ) {
          if (await verify(step.id)) {
            this.store.event(run.id, "step.reconciled", {}, step.id);
            continue;
          }
        }
        const provider = (await this.providers()).find(
          (p) => p.id === step.providerId,
        );
        if (!provider)
          throw new Error("The planned provider is no longer configured");
        let stepPacket: ContextPacket = packet;
        for (
          let attempt = 1;
          attempt <= this.config.policy.maxAttempts;
          attempt++
        ) {
          if (signal.aborted) throw new Error("Run cancelled");
          await this.refresh();
          if (hash(this.config.policy) !== run.plan.policyHash)
            throw new Error(
              "Policy changed during execution; dispatch stopped",
            );
          assertProvider(provider, this.config.policy, step.effort);
          this.store.event(
            run.id,
            "attempt.started",
            { attempt, providerId: provider.id },
            step.id,
          );
          let proposalApplied = false;
          for (let turn = 0; turn < this.config.policy.maxTurns; turn++) {
            await this.refresh();
            if (hash(this.config.policy) !== run.plan.policyHash)
              throw new Error("Policy changed during execution");
            const estimate = estimateRequestCost(
              provider,
              this.config.policy.maxContextTokens,
              this.config.policy.maxOutputTokens,
            );
            if (
              this.config.policy.maxCostUsd !== null &&
              (estimate === null ||
                run.usage.costUsd === null ||
                run.usage.costUsd + estimate > this.config.policy.maxCostUsd)
            )
              throw new Error(
                "The next call exceeds the configured estimated cost budget",
              );
            this.store.event(
              run.id,
              "worker.dispatched",
              {
                provider: provider.id,
                model: provider.model,
                effort: step.effort ?? null,
                attempt,
                turn,
                contextItems: stepPacket.items.length,
              },
              step.id,
            );
            // Test logs may quote private source even when they contain no key-like
            // strings. They stay local; remote workers get only a generic failure.
            const workerFeedback =
              provider.kind === "local"
                ? feedback
                : feedback
                  ? "Required verification failed. Request explicitly exportable source to investigate."
                  : "";
            const input: WorkerInput = {
              provider,
              policy: this.config.policy,
              context: stepPacket,
              objective: step.objective,
              acceptance: run.plan.acceptance,
              effort: step.effort,
              feedback: workerFeedback,
              signal,
            };
            const result = this.deps.worker
              ? await this.deps.worker(input, workspace)
              : ["codex", "claude", "cursor"].includes(provider.kind)
                ? await invokeInstalledWorker(input, workspace)
                : await invokeApiWorker(input);
            run.usage = sumUsage(run.usage, result.usage);
            save("running");
            this.store.event(
              run.id,
              "worker.completed",
              {
                usage: result.usage,
                model: result.model,
                summary: result.proposal.summary,
              },
              step.id,
            );
            if (signal.aborted) throw new Error("Run cancelled");
            await this.refresh();
            if (hash(this.config.policy) !== run.plan.policyHash)
              throw new Error("Policy changed before patch application");
            if (result.proposal.requests.length) {
              const items = [];
              for (const relative of result.proposal.requests) {
                if (
                  provider.kind !== "local" &&
                  !isAllowedPath(relative, this.config.policy, true)
                )
                  throw new Error(
                    `Source request is not exportable: ${relative}`,
                  );
                const content = await readFile(
                  await safePath(workspace, relative, this.config.policy),
                  "utf8",
                );
                if (content.length > this.config.policy.maxContextTokens * 3)
                  throw new Error(
                    `Requested file is too large for the context budget: ${relative}`,
                  );
                items.push({
                  id: hash(relative + content),
                  kind: "code" as const,
                  text: content,
                  score: 1,
                  source: {
                    path: relative,
                    startLine: 1,
                    endLine: content.split("\n").length,
                    contentHash: hash(content),
                    snapshotId: run.plan.snapshotId,
                  },
                });
              }
              stepPacket = {
                ...stepPacket,
                items,
                estimatedTokens:
                  Math.ceil(JSON.stringify(items).length / 3) +
                  Math.ceil(JSON.stringify(stepPacket.mandatory).length / 3),
              };
              contextForProvider(stepPacket, provider, this.config.policy);
              continue;
            }
            const changed = await applyProposal(
              workspace,
              result.proposal,
              this.config.policy,
            );
            this.store.event(
              run.id,
              "patch.applied",
              { paths: changed },
              step.id,
            );
            proposalApplied = true;
            break;
          }
          if (!proposalApplied)
            throw new Error("Worker exhausted its turn budget without a patch");
          if (await verify(step.id)) break;
          save("running");
          stepPacket = await currentContext();
        }
        if (!verified)
          throw new Error("Required checks failed after the allowed attempts");
      }
      if (signal.aborted) throw new Error("Run cancelled");
      await this.refresh();
      if (hash(this.config.policy) !== run.plan.policyHash)
        throw new Error("Policy changed before publication");
      if (!verifiedHash)
        throw new Error(
          "No verified source snapshot is available for publication",
        );
      this.store.event(run.id, "publication.started", {
        mode: run.plan.publication,
        snapshotHash: verifiedHash,
      });
      Object.assign(
        run,
        await publishRun(this.root, run, this.config, verifiedHash, signal),
      );
      this.store.event(run.id, "publication.completed", {
        commit: run.commit ?? null,
        pullRequest: run.pullRequest ?? null,
      });
      save("succeeded");
      this.store.event(run.id, "run.succeeded", { usage: run.usage });
      try {
        await this.context.createMemory({
          kind: "observation",
          text: `Completed task: ${run.plan.objective}. Required automated checks passed. Run ${run.id}${run.commit ? `, commit ${run.commit}` : ""}. Acceptance still receives human PR review.`,
        });
      } catch (error) {
        this.store.event(run.id, "memory.capture_failed", {
          error: errorMessage(error),
        });
      }
    } catch (error) {
      run.error = redact(errorMessage(error));
      const events = this.store.events(run.id);
      const publishing =
        events.findLastIndex((e) => e.type === "publication.started") >
        events.findLastIndex((e) => e.type === "publication.completed");
      save(
        signal.aborted
          ? "cancelled"
          : publishing
            ? "needs_reconciliation"
            : "failed",
      );
      this.store.event(run.id, "run.stopped", {
        status: run.status,
        error: run.error,
      });
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      for (const { controller } of this.active.values()) controller.abort();
      await Promise.all([...this.active.values()].map((a) => a.promise));
      await this.context.close();
      this.store.close();
    })());
  }
}
function compactFailures(checks: VerificationResult[]): string {
  return checks
    .filter((c) => c.code !== 0)
    .map(
      (c) =>
        `${c.argv.join(" ")} exited ${c.code}\n${redact(c.stderr || c.stdout).slice(-6000)}`,
    )
    .join("\n")
    .slice(-12000);
}
