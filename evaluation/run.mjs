#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { tasks } from "./tasks.mjs";
const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");

export function runCommand(argv, { cwd, input, timeoutMs = 600000 } = {}) {
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    argv.some((value) => typeof value !== "string" || !value)
  )
    throw new Error("Command must be a nonempty JSON array of argv strings");
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      terminated = false,
      force;
    const kill = (signal) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const stop = () => {
      if (terminated) return;
      terminated = true;
      kill("SIGTERM");
      force = setTimeout(() => kill("SIGKILL"), 1000);
      force.unref();
    };
    const timer = setTimeout(stop, timeoutMs);
    timer.unref();
    const finish = () => {
      clearTimeout(timer);
      clearTimeout(force);
    };
    for (const [stream, name] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ])
      stream.on("data", (buffer) => {
        bytes += buffer.length;
        if (bytes > 2_000_000) {
          stop();
          return;
        }
        if (name === "stdout") stdout += buffer.toString();
        else stderr += buffer.toString();
      });
    child.on("error", (error) => {
      finish();
      reject(error);
    });
    child.on("close", (code) => {
      finish();
      resolve({ code: terminated ? null : code, stdout, stderr, terminated });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export function parseReceipt(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Adapter receipt must be an object");
  const usage = {};
  for (const field of ["inputTokens", "outputTokens", "costUsd"]) {
    const amount = value.usage?.[field] ?? null;
    if (
      amount !== null &&
      (typeof amount !== "number" ||
        !Number.isFinite(amount) ||
        amount < 0 ||
        (field !== "costUsd" && !Number.isInteger(amount)))
    )
      throw new Error(`Invalid usage.${field}`);
    usage[field] = amount;
  }
  const decisions = value.decisions ?? [];
  if (!Array.isArray(decisions))
    throw new Error("Adapter decisions must be an array");
  for (const decision of decisions)
    if (
      !decision ||
      ["caseId", "category", "provider", "model"].some(
        (key) => typeof decision[key] !== "string" || !decision[key],
      ) ||
      !(decision.selected === null || typeof decision.selected === "string") ||
      typeof decision.confidence !== "number" ||
      !Number.isFinite(decision.confidence) ||
      decision.confidence < 0 ||
      decision.confidence > 1
    )
      throw new Error("Invalid observed decision receipt");
  return {
    usage,
    decisions: decisions.map(
      ({ caseId, category, provider, model, selected, confidence }) => ({
        caseId,
        category,
        provider,
        model,
        selected,
        confidence,
      }),
    ),
    policyViolation: value.policyViolation === true,
  };
}
async function writeFiles(root, files) {
  await mkdir(root, { recursive: true });
  for (const [name, text] of Object.entries(files))
    await writeFile(path.join(root, name), text, { flag: "wx" });
}
async function sourceHash(task, workspace) {
  const values = [];
  for (const filename of Object.keys(task.files).sort()) {
    try {
      values.push([
        filename,
        await readFile(path.join(workspace, filename), "utf8"),
      ]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      values.push([filename, null]);
    }
  }
  return hash(values);
}
async function configurationHash(argv) {
  const profileIndex = argv.indexOf("--profile");
  const profile =
    profileIndex >= 0
      ? argv[profileIndex + 1]
      : argv.find((value) => value.startsWith("--profile="))?.slice(10);
  return hash({
    commandHash: hash(argv),
    profileHash: profile ? hash(await readFile(profile)) : null,
  });
}
async function verify(task, workspace, checks, imageId) {
  const name = `graph-evaluation-${randomUUID()}`;
  const before = await sourceHash(task, workspace);
  try {
    const result = await runCommand([
      "docker",
      "run",
      "--rm",
      "--name",
      name,
      "--pull=never",
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=256",
      "--memory=4g",
      "--cpus=2",
      "--mount",
      `type=bind,source=${workspace},target=/workspace,readonly`,
      "--mount",
      `type=bind,source=${checks},target=/checks,readonly`,
      "--env",
      "DOTNET_CLI_TELEMETRY_OPTOUT=1",
      "--env",
      "DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1",
      imageId,
      ...task.verification.argv,
    ]);
    const after = await sourceHash(task, workspace);
    return {
      success:
        before === after &&
        result.code === 0 &&
        result.stdout.split(/\r?\n/).includes(task.marker),
      exitCode: result.code,
      imageId,
      sourceHash: before,
      sourceUnchanged: before === after,
      harnessHash: hash({
        files: task.verification.files,
        argv: task.verification.argv,
      }),
      stdout: result.stdout.slice(-8000),
      stderr: result.stderr.slice(-8000),
    };
  } finally {
    await runCommand(["docker", "rm", "-f", name], { timeoutMs: 10000 }).catch(
      () => {},
    );
  }
}
export function toEvaluationRows(results, labels) {
  const rows = [];
  for (const result of results)
    for (const decision of result.candidate.decisions) {
      const label = labels.find(
        (item) =>
          item.taskId === result.taskId &&
          item.caseId === decision.caseId &&
          item.category === decision.category,
      );
      if (
        !label ||
        result.baseline.usage.costUsd === null ||
        result.candidate.usage.costUsd === null
      )
        continue;
      if (
        !["calibration", "held-out"].includes(label.split) ||
        typeof label.expected !== "string" ||
        !label.expected
      )
        throw new Error("Invalid external decision label");
      rows.push({
        ...decision,
        expected: label.expected,
        split: label.split,
        taskId: result.taskId,
        baselineSuccess:
          result.baseline.adapterExitCode === 0 &&
          result.baseline.verification.success,
        candidateSuccess:
          result.candidate.adapterExitCode === 0 &&
          result.candidate.verification.success,
        baselineCost: result.baseline.usage.costUsd,
        candidateCost: result.candidate.usage.costUsd,
        policyViolation: result.candidate.policyViolation,
      });
    }
  return rows;
}
async function main() {
  const { values } = parseArgs({
    options: {
      list: { type: "boolean" },
      "baseline-command": { type: "string" },
      "candidate-command": { type: "string" },
      output: { type: "string" },
      "rows-output": { type: "string" },
      labels: { type: "string" },
      task: { type: "string", multiple: true },
      limit: { type: "string" },
    },
  });
  const limit =
    values.limit === undefined ? tasks.length : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > tasks.length)
    throw new Error("Limit must be between 1 and 60");
  if (values.task?.some((id) => !tasks.some((task) => task.id === id)))
    throw new Error("Unknown task id");
  const selected = tasks
    .filter((task) => !values.task || values.task.includes(task.id))
    .slice(0, limit);
  if (values.list) {
    console.log(
      JSON.stringify(
        selected.map(({ id, language, objective, verification }) => ({
          id,
          language,
          objective,
          image: verification.image,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (
    !values["baseline-command"] ||
    !values["candidate-command"] ||
    !values.output
  )
    throw new Error(
      "Provide baseline-command, candidate-command JSON argv arrays, and a new output file, or use --list",
    );
  for (const target of [values.output, values["rows-output"]].filter(Boolean)) {
    try {
      await lstat(target);
      throw new Error(`Output already exists: ${target}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const commands = {
    baseline: JSON.parse(values["baseline-command"]),
    candidate: JSON.parse(values["candidate-command"]),
  };
  for (const command of Object.values(commands))
    if (
      !Array.isArray(command) ||
      !command.length ||
      command.some((value) => typeof value !== "string" || !value)
    )
      throw new Error("Adapter commands must be JSON argv arrays");
  const imageIds = new Map();
  for (const image of new Set(
    selected.map((task) => task.verification.image),
  )) {
    const inspected = await runCommand(
      ["docker", "image", "inspect", "--format", "{{.Id}}", image],
      { timeoutMs: 10000 },
    );
    if (
      inspected.code !== 0 ||
      !/^sha256:[a-f0-9]{64}$/.test(inspected.stdout.trim())
    )
      throw new Error(
        `Provision verification image explicitly before running: ${image}`,
      );
    imageIds.set(image, inspected.stdout.trim());
  }
  const labels = values.labels
    ? JSON.parse(await readFile(values.labels, "utf8"))
    : [];
  if (!Array.isArray(labels)) throw new Error("Labels must be a JSON array");
  const directory = await mkdtemp(path.join(tmpdir(), "graph-evaluation-")),
    results = [];
  const startedAt = new Date().toISOString();
  const sourceCodeHash = hash(
    await Promise.all(
      ["tasks.mjs", "run.mjs", "api-adapter.mjs"].map(async (name) => [
        name,
        hash(await readFile(new URL(name, import.meta.url))),
      ]),
    ),
  );
  try {
    for (const task of selected) {
      const checks = path.join(directory, task.id, "checks");
      await writeFiles(checks, task.verification.files);
      const result = {
        taskId: task.id,
        language: task.language,
        synthetic: true,
        initialSourceHash: hash(task.files),
      };
      // Counterbalance order by task index to reduce systematic warmup bias.
      const variants =
        results.length % 2
          ? ["candidate", "baseline"]
          : ["baseline", "candidate"];
      for (const variant of variants) {
        const workspace = path.join(directory, task.id, variant);
        await writeFiles(workspace, task.files);
        const configHash = await configurationHash(commands[variant]);
        const start = performance.now();
        const execution = await runCommand(commands[variant], {
          cwd: process.cwd(),
          input: JSON.stringify({
            version: "1.0.0",
            taskId: task.id,
            language: task.language,
            workspace,
            objective: task.objective,
            acceptance: task.acceptance,
            allowedFiles: Object.keys(task.files),
          }),
        });
        let receipt = {
            usage: { inputTokens: null, outputTokens: null, costUsd: null },
            decisions: [],
            policyViolation: false,
          },
          receiptError;
        try {
          receipt = parseReceipt(execution.stdout);
        } catch (error) {
          receiptError = error.message;
        }
        const verification = await verify(
          task,
          workspace,
          checks,
          imageIds.get(task.verification.image),
        );
        const configUnchanged =
          configHash === (await configurationHash(commands[variant]));
        if (!configUnchanged) verification.success = false;
        result[variant] = {
          ...receipt,
          configurationHash: configHash,
          configurationUnchanged: configUnchanged,
          elapsedMs: performance.now() - start,
          adapterExitCode: execution.code,
          verification,
          ...(receiptError ? { receiptError } : {}),
        };
        process.stderr.write(
          `${task.id} ${variant}: ${verification.success ? "passed" : "failed"}\n`,
        );
      }
      results.push(result);
    }
    const artifact = {
      version: "1.0.0",
      kind: "synthetic-engineering-evaluation",
      sourceCodeHash,
      startedAt,
      finishedAt: new Date().toISOString(),
      taskCount: results.length,
      results,
    };
    await writeFile(
      path.resolve(values.output),
      JSON.stringify(artifact, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    if (values["rows-output"])
      await writeFile(
        path.resolve(values["rows-output"]),
        JSON.stringify(toEvaluationRows(results, labels), null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
