import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { tasks } from "./tasks.mjs";
import { parseReceipt, runCommand, toEvaluationRows } from "./run.mjs";

test("60 synthetic tasks cover six language families, with distinct broken and oracle files", () => {
  assert.equal(tasks.length, 60);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 60);
  assert.equal(new Set(tasks.map((task) => task.language)).size, 6);
  for (const task of tasks) {
    assert.equal(task.synthetic, true);
    assert.notDeepEqual(task.files, task.oracleFiles);
    assert.equal(task.tests.length, 8);
  }
});
test("all JavaScript and Python fixtures fail before repair and pass the actual oracle checks", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "graph-evaluation-tests-"),
  );
  try {
    for (const task of tasks.filter((task) =>
      ["javascript", "python"].includes(task.language),
    )) {
      const file = Object.keys(task.files)[0],
        check = Object.keys(task.verification.files)[0];
      await writeFile(
        path.join(directory, check),
        task.verification.files[check].replaceAll("/workspace", directory),
      );
      await writeFile(path.join(directory, file), task.files[file]);
      const argv = [
        task.language === "javascript" ? process.execPath : "python3",
        ...(task.language === "python" ? ["-B"] : []),
        path.join(directory, check),
      ];
      assert.notEqual(
        (await runCommand(argv)).code,
        0,
        `${task.id} must reproduce a failure`,
      );
      await writeFile(path.join(directory, file), task.oracleFiles[file]);
      const result = await runCommand(argv);
      assert.equal(result.code, 0, `${task.id}: ${result.stderr}`);
      assert.ok(result.stdout.includes(task.marker));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("unknown usage stays null and missing labels or costs cannot manufacture evaluation evidence", () => {
  assert.deepEqual(parseReceipt("{}").usage, {
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  assert.throws(() => parseReceipt('{"usage":{"costUsd":-1}}'));
  const decision = {
    caseId: "decision-1",
    category: "worker",
    provider: "laya",
    model: "model",
    selected: "local",
    confidence: 0.8,
  };
  const result = {
    taskId: "task-1",
    baseline: { usage: { costUsd: 1 }, verification: { success: true } },
    candidate: {
      usage: { costUsd: null },
      decisions: [decision],
      verification: { success: true },
      policyViolation: false,
    },
  };
  const labels = [
    {
      taskId: "task-1",
      caseId: "decision-1",
      category: "worker",
      split: "held-out",
      expected: "local",
    },
  ];
  assert.equal(toEvaluationRows([result], labels).length, 0);
  result.candidate.usage.costUsd = 0.5;
  assert.equal(toEvaluationRows([result], []).length, 0);
  const [row] = toEvaluationRows([result], labels);
  assert.equal(row.baselineCost, 1);
  assert.equal(row.candidateCost, 0.5);
  assert.equal(row.selected, decision.selected);
});
