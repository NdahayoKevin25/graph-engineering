import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  access,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_POLICY,
  type ProjectConfig,
  type RunRecord,
} from "@graph-engineering/contracts";
import {
  createWorkspace,
  workspaceFingerprint,
} from "../src/execution/workspace.js";
import { publishRun } from "../src/execution/publish.js";
import * as util from "../src/util.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "graph-publication-"));
  roots.push(base);
  const root = path.join(base, "source");
  await mkdir(root);
  await util.checked("git", ["init", "-b", "dev"], { cwd: root });
  await util.checked("git", ["config", "user.name", "Graph Test"], {
    cwd: root,
  });
  await util.checked("git", ["config", "core.autocrlf", "false"], {
    cwd: root,
  });
  await util.checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await writeFile(
    path.join(root, "math.cjs"),
    "exports.add = (a,b) => a - b;\n",
  );
  await util.checked("git", ["add", "."], { cwd: root });
  await util.checked(
    "git",
    ["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"],
    { cwd: root },
  );
  const config: ProjectConfig = {
    version: "1.0.0",
    projectId: "test-project",
    name: "test",
    policy: { ...structuredClone(DEFAULT_POLICY), publication: "commit" },
    verification: [],
  };
  const timestamp = new Date().toISOString();
  const run: RunRecord = {
    id: "test-run",
    status: "verifying",
    createdAt: timestamp,
    updatedAt: timestamp,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      estimated: false,
    },
    plan: {
      version: "1.0.0",
      id: "test-plan",
      projectId: config.projectId,
      snapshotId: "snapshot",
      policyHash: "policy",
      createdAt: timestamp,
      objective: "Fix addition",
      acceptance: ["addition works"],
      steps: [],
      verification: [],
      publication: "commit",
    },
  };
  return { base, root, config, run };
}
describe("safe recoverable publication", () => {
  it("recovers workspace creation before run metadata was persisted", async () => {
    const { base, root, config, run } = await fixture();
    const first = await createWorkspace(root, base, run.id, config.policy);
    expect(await createWorkspace(root, base, run.id, config.policy)).toEqual(
      first,
    );
    expect(
      await readFile(path.join(first.workspace, "math.cjs"), "utf8"),
    ).toContain("a - b");
  });
  it("reconciles a clean run-owned commit without creating a duplicate", async () => {
    const { base, root, config, run } = await fixture();
    Object.assign(
      run,
      await createWorkspace(root, base, run.id, config.policy),
    );
    await writeFile(
      path.join(run.workspace!, "math.cjs"),
      "exports.add = (a,b) => a + b;\n",
    );
    const fingerprint = await workspaceFingerprint(
      run.workspace!,
      config.policy,
    );
    const first = await publishRun(root, run, config, fingerprint);
    const second = await publishRun(root, run, config, fingerprint);
    expect(second.commit).toBe(first.commit);
    expect(first.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(
      await util.checked("git", ["rev-list", "--count", "HEAD"], {
        cwd: run.workspace,
      }),
    ).toBe("2");
  });
  it("reconciles a pushed commit after a PR lookup fails without committing twice", async () => {
    const { base, root, config, run } = await fixture();
    Object.assign(
      run,
      await createWorkspace(root, base, run.id, config.policy),
    );
    config.policy.publication = "draft-pr";
    config.policy.network = "allowlisted";
    config.policy.allowedHosts = ["github.com"];
    config.github = {
      repository: "test-owner/test-repo",
      baseBranch: "dev",
      remote: "origin",
    };
    await util.checked(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://github.com/test-owner/test-repo.git",
      ],
      { cwd: root },
    );
    await writeFile(
      path.join(run.workspace!, "math.cjs"),
      "exports.add = (a,b) => a + b;\n",
    );
    const actualCommand = util.command;
    let pushes = 0,
      lookups = 0;
    vi.spyOn(util, "command").mockImplementation(
      async (executable, argv, options) => {
        if (executable === "git" && argv.includes("push")) {
          pushes++;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (executable === "gh") {
          expect(argv).toContain("github.com/test-owner/test-repo");
          return ++lookups === 1
            ? { code: 1, stdout: "", stderr: "transient failure" }
            : {
                code: 0,
                stdout: "https://github.com/test-owner/test-repo/pull/1\n",
                stderr: "",
              };
        }
        return actualCommand(executable, argv, options);
      },
    );
    const fingerprint = await workspaceFingerprint(
      run.workspace!,
      config.policy,
    );
    await expect(publishRun(root, run, config, fingerprint)).rejects.toThrow(
      "reconcile",
    );
    const committed = await util.checked("git", ["rev-parse", "HEAD"], {
      cwd: run.workspace,
    });
    const recovered = await publishRun(root, run, config, fingerprint);
    expect(recovered).toEqual({
      commit: committed,
      pullRequest: "https://github.com/test-owner/test-repo/pull/1",
    });
    expect(pushes).toBe(2);
    expect(
      await util.checked("git", ["rev-list", "--count", "HEAD"], {
        cwd: run.workspace,
      }),
    ).toBe("2");
  });
  it("refuses a pushurl outside the configured repository before committing", async () => {
    const { base, root, config, run } = await fixture();
    Object.assign(
      run,
      await createWorkspace(root, base, run.id, config.policy),
    );
    config.policy.publication = "draft-pr";
    config.policy.network = "allowlisted";
    config.policy.allowedHosts = ["github.com"];
    config.github = {
      repository: "test-owner/test-repo",
      baseBranch: "dev",
      remote: "origin",
    };
    await util.checked(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://github.com/test-owner/test-repo.git",
      ],
      { cwd: root },
    );
    await util.checked(
      "git",
      [
        "remote",
        "set-url",
        "--push",
        "origin",
        "https://unapproved.example/repo.git",
      ],
      { cwd: root },
    );
    await writeFile(path.join(run.workspace!, "math.cjs"), "changed\n");
    await expect(publishRun(root, run, config)).rejects.toThrow("push remote");
    expect(
      await util.checked("git", ["rev-list", "--count", "HEAD"], {
        cwd: run.workspace,
      }),
    ).toBe("1");
  });
  it("does not run checkout or commit hooks", async () => {
    const { base, root, config, run } = await fixture();
    const hooks = path.join(base, "hooks");
    await mkdir(hooks);
    const marker = path.join(base, "executed");
    for (const name of ["post-checkout", "pre-commit", "post-commit"]) {
      const file = path.join(hooks, name);
      await writeFile(file, `#!/bin/sh\necho unsafe > '${marker}'\n`);
      await chmod(file, 0o755);
    }
    await util.checked("git", ["config", "core.hooksPath", hooks], {
      cwd: root,
    });
    Object.assign(
      run,
      await createWorkspace(root, base, run.id, config.policy),
    );
    await writeFile(
      path.join(run.workspace!, "math.cjs"),
      "exports.add = (a,b) => a + b;\n",
    );
    await publishRun(root, run, config);
    await expect(access(marker)).rejects.toThrow();
    expect(
      await readFile(path.join(run.workspace!, "math.cjs"), "utf8"),
    ).toContain("a + b");
  });
  it("never executes configured filters or silently commits unfiltered LFS content", async () => {
    const { base, root, config, run } = await fixture();
    const marker = path.join(base, "executed");
    const filter = `echo unsafe > '${marker}'; cat`;
    await util.checked("git", ["config", "filter.host.clean", filter], {
      cwd: root,
    });
    await util.checked("git", ["config", "filter.host.smudge", filter], {
      cwd: root,
    });
    await util.checked("git", ["config", "filter.host.required", "true"], {
      cwd: root,
    });
    await writeFile(path.join(root, ".gitattributes"), "*.cjs filter=host\n");
    await util.checked(
      "git",
      [
        "-c",
        "filter.host.clean=",
        "-c",
        "filter.host.smudge=",
        "-c",
        "filter.host.required=false",
        "add",
        ".gitattributes",
      ],
      { cwd: root },
    );
    await util.checked(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "filter.host.clean=",
        "-c",
        "filter.host.smudge=",
        "-c",
        "filter.host.required=false",
        "commit",
        "-m",
        "attributes fixture",
      ],
      { cwd: root },
    );
    Object.assign(
      run,
      await createWorkspace(root, base, run.id, config.policy),
    );
    await writeFile(
      path.join(run.workspace!, "math.cjs"),
      "exports.add = (a,b) => a + b;\n",
    );
    await expect(publishRun(root, run, config)).rejects.toThrow("Git-filtered");
    await expect(access(marker)).rejects.toThrow();
  });
  it("refuses changed or switched workspaces after verification", async () => {
    const { base, root, config, run } = await fixture();
    Object.assign(
      run,
      await createWorkspace(root, base, run.id, config.policy),
    );
    const fingerprint = await workspaceFingerprint(
      run.workspace!,
      config.policy,
    );
    await writeFile(path.join(run.workspace!, "math.cjs"), "changed\n");
    await expect(publishRun(root, run, config, fingerprint)).rejects.toThrow(
      "after verification",
    );
    await expect(
      publishRun(root, { ...run, branch: "graph/another" }, config),
    ).rejects.toThrow("run branch");
  });
  it("checks staged-only files against protected scope", async () => {
    const { base, root, config, run } = await fixture();
    Object.assign(
      run,
      await createWorkspace(root, base, run.id, config.policy),
    );
    await mkdir(path.join(run.workspace!, ".graph"));
    await writeFile(path.join(run.workspace!, ".graph", "project.json"), "{}");
    await util.checked("git", ["add", ".graph/project.json"], {
      cwd: run.workspace,
    });
    await expect(publishRun(root, run, config)).rejects.toThrow(
      "allowed scope",
    );
  });
});
