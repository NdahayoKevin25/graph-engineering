#!/usr/bin/env node
// Explicit benchmark adapter: sends only the synthetic fixture to configured
// API workers. The outer runner independently verifies the resulting source.
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { assertProjectConfig } from "../packages/contracts/dist/index.js";
import { ContextEngine } from "../packages/engine/dist/context/index.js";
import { invokeApiWorker } from "../packages/engine/dist/workers/api.js";
import { applyProposal } from "../packages/engine/dist/execution/workspace.js";
import { assertProvider } from "../packages/engine/dist/policy.js";
import { decide } from "../packages/engine/dist/decisions.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  decisions = [];
let engine, directory;
async function main() {
  const { values } = parseArgs({ options: { profile: { type: "string" } } });
  if (!values.profile)
    throw new Error(
      "Provide --profile with reviewed worker/policy configuration",
    );
  const profile = JSON.parse(await readFile(values.profile, "utf8"));
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 65536) throw new Error("Task input too large");
  }
  const task = JSON.parse(input);
  if (
    !["full", "graph"].includes(profile.contextMode) ||
    !Array.isArray(profile.providers) ||
    !Array.isArray(task.allowedFiles) ||
    task.allowedFiles.some(
      (name) => typeof name !== "string" || path.basename(name) !== name,
    )
  )
    throw new Error("Invalid profile or fixture task");
  const projectId = randomUUID();
  assertProjectConfig({
    version: "1.0.0",
    projectId,
    name: "Synthetic evaluation",
    policy: profile.policy,
    verification: [],
  });
  for (const provider of profile.providers) {
    if (!["local", "openai", "anthropic"].includes(provider.kind))
      throw new Error(
        "This benchmark adapter supports local/OpenAI/Anthropic API workers",
      );
    assertProvider(provider, profile.policy, provider.defaultEffort);
  }
  let provider = profile.providers.find(
    (item) => item.id === profile.baselineProviderId,
  );
  if (!provider) throw new Error("Baseline provider is not configured");
  if (profile.decisionProviders?.length) {
    // Experimental routing inside isolated benchmark fixtures is explicit in
    // the profile. It does not enable production promotion or alter policy.
    const records = await decide({
      projectId,
      category: "worker",
      state: {
        objective: task.objective,
        language: task.language,
        files: task.allowedFiles.length,
      },
      candidates: Object.fromEntries(
        profile.providers.map((item) => [
          item.id,
          `${item.kind} ${item.model}`,
        ]),
      ),
      baseline: provider.id,
      policy: { ...profile.policy, decisionMode: "shadow" },
      providers: profile.decisionProviders,
    });
    const observed =
      records.find((record) => record.selected) ?? records.at(-1);
    if (observed)
      decisions.push({
        caseId: `${task.taskId}-worker`,
        category: "worker",
        provider: observed.provider,
        model: observed.modelVersion,
        selected: observed.selected,
        confidence: observed.confidence ?? 0,
      });
    if (observed?.selected)
      provider = profile.providers.find(
        (item) => item.id === observed.selected,
      );
    // The current decision interface does not report hosted Jev billing.
    // Unknown cost must block cost-based promotion, not silently count as free.
    if (records.some((record) => record.provider === "jev"))
      usage.costUsd = null;
  }
  directory = await mkdtemp(path.join(tmpdir(), "graph-evaluation-context-"));
  engine = new ContextEngine({
    projectId,
    root: task.workspace,
    dataDir: directory,
    policy: profile.policy,
  });
  const snapshot = await engine.index();
  const fullPacket = async (paths) => {
    const items = [];
    for (const filename of paths) {
      const text = await readFile(path.join(task.workspace, filename), "utf8");
      items.push({
        id: hash(filename + text),
        kind: "code",
        text,
        score: 1,
        source: {
          path: filename,
          startLine: 1,
          endLine: text.split("\n").length,
          contentHash: hash(text),
          snapshotId: snapshot.id,
        },
      });
    }
    return {
      version: "1.0.0",
      projectId,
      snapshotId: snapshot.id,
      query: task.objective,
      mandatory: task.acceptance,
      items,
      estimatedTokens: Buffer.byteLength(
        JSON.stringify(items) + task.objective + task.acceptance.join("\n"),
      ),
      budgetTokens: profile.policy.maxContextTokens,
      coverage: { semantic: false, graph: "Full fixture source", warnings: [] },
    };
  };
  let context =
    profile.contextMode === "graph"
      ? await engine.getContext({
          query: task.objective,
          snapshotId: snapshot.id,
          mandatory: task.acceptance,
        })
      : await fullPacket(task.allowedFiles);
  for (let turn = 0; turn < profile.policy.maxTurns; turn++) {
    let result;
    try {
      result = await invokeApiWorker({
        provider,
        policy: profile.policy,
        context,
        objective: task.objective,
        acceptance: task.acceptance,
        effort: provider.defaultEffort,
      });
    } catch (error) {
      for (const key of Object.keys(usage)) usage[key] = null;
      throw error;
    }
    for (const key of Object.keys(usage))
      usage[key] =
        usage[key] === null || result.usage[key] === null
          ? null
          : usage[key] + result.usage[key];
    if (result.proposal.requests.length) {
      if (
        result.proposal.requests.some(
          (filename) => !task.allowedFiles.includes(filename),
        )
      )
        throw new Error("Worker requested source outside fixture scope");
      context = await fullPacket(result.proposal.requests);
      continue;
    }
    if (
      result.proposal.changes.some(
        (change) => !task.allowedFiles.includes(change.path),
      )
    )
      throw new Error("Worker proposed a change outside fixture scope");
    await applyProposal(task.workspace, result.proposal, profile.policy);
    return;
  }
  throw new Error("Worker exhausted its turn budget");
}
try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await engine?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  process.stdout.write(
    JSON.stringify({ usage, decisions, policyViolation: false }) + "\n",
  );
}
