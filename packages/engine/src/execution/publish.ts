import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { ProjectConfig, RunRecord } from "@graph-engineering/contracts";
import { assertPublication, isAllowedPath } from "../policy.js";
import { checked, command } from "../util.js";
import { checkedGit, managedGit } from "./git.js";
import { workspaceFingerprint } from "./workspace.js";

export async function publishRun(
  root: string,
  run: RunRecord,
  config: ProjectConfig,
  verifiedHash?: string,
  signal?: AbortSignal,
): Promise<{ commit?: string; pullRequest?: string }> {
  if (!run.workspace || !run.branch)
    throw new Error("Run has no execution workspace");
  if (config.policy.publication === "none") return {};
  assertPublication(config.policy, run.branch);
  const cancelled = () => {
    if (signal?.aborted) throw new Error("Run cancelled before publication");
  };
  const assertVerified = async () => {
    cancelled();
    if (
      verifiedHash !== undefined &&
      (await workspaceFingerprint(run.workspace!, config.policy)) !==
        verifiedHash
    )
      throw new Error(
        "Workspace changed after verification; publication stopped",
      );
  };
  const currentBranch = await checkedGit(run.workspace, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (currentBranch !== run.branch)
    throw new Error("Execution workspace is no longer on its run branch");
  let repository: string | undefined;
  if (config.policy.publication === "draft-pr") {
    if (!config.github)
      throw new Error(
        "Configure the GitHub repository and dev base branch before opening PRs",
      );
    if (["main", "master"].includes(config.github.baseBranch))
      throw new Error(
        "This workspace uses dev as its integration branch; main/master PR targets are prohibited",
      );
    if (
      !/^[A-Za-z0-9_./-]+$/.test(config.github.remote) ||
      config.github.remote.startsWith("-")
    )
      throw new Error("Invalid Git remote name");
    repository = config.github.repository.replace(/\.git$/, "");
    // Check actual push destinations, including pushurl/insteadOf expansion.
    const remotes = (
      await checkedGit(root, [
        "remote",
        "get-url",
        "--push",
        "--all",
        config.github.remote,
      ])
    ).split("\n");
    const allowed = [
      `https://github.com/${repository}`,
      `https://github.com/${repository}.git`,
      `git@github.com:${repository}.git`,
    ];
    if (remotes.length !== 1 || !allowed.includes(remotes[0]))
      throw new Error(
        "Git push remote does not match the configured GitHub repository",
      );
  }
  await assertVerified();
  const changes = await managedGit(run.workspace, [
    "status",
    "--porcelain=v1",
    "-z",
  ]);
  if (changes.code !== 0)
    throw new Error("Cannot inspect publication workspace");
  let commit: string | undefined;
  if (changes.stdout.length) {
    const unstaged = await managedGit(run.workspace, [
      "ls-files",
      "-m",
      "-o",
      "-d",
      "--exclude-standard",
      "-z",
    ]);
    const staged = await managedGit(run.workspace, [
      "diff",
      "--cached",
      "--name-only",
      "--no-ext-diff",
      "-z",
    ]);
    if (unstaged.code !== 0 || staged.code !== 0)
      throw new Error("Cannot inspect changed publication files");
    const files = [
      ...new Set(
        [...unstaged.stdout.split("\0"), ...staged.stdout.split("\0")].filter(
          Boolean,
        ),
      ),
    ];
    if (
      !files.length ||
      files.some((file) => !isAllowedPath(file, config.policy))
    )
      throw new Error("Workspace changed files outside the allowed scope");
    const attributes = await managedGit(run.workspace, [
      "check-attr",
      "-z",
      "filter",
      "--",
      ...files,
    ]);
    if (attributes.code !== 0)
      throw new Error("Cannot inspect Git attributes before publication");
    const attributeFields = attributes.stdout.split("\0");
    for (let i = 2; i < attributeFields.length; i += 3)
      if (!["unspecified", "unset"].includes(attributeFields[i])) {
        throw new Error(
          "Publication of Git-filtered files (including Git LFS) requires manual review; host filters are never executed",
        );
      }
    await checkedGit(run.workspace, ["add", "--", ...files]);
    for (const file of files) {
      const stagedBlob = await managedGit(run.workspace, [
        "rev-parse",
        "--verify",
        `:${file}`,
      ]);
      if (stagedBlob.code !== 0) continue; // Staged deletion.
      const sourceBlob = await checkedGit(run.workspace, [
        "hash-object",
        "--no-filters",
        "--",
        file,
      ]);
      if (stagedBlob.stdout.trim() !== sourceBlob)
        throw new Error(
          "Git normalization changes verified source bytes; manual publication is required",
        );
    }
    await assertVerified();
    await checkedGit(run.workspace, [
      "commit",
      "-m",
      `feat: ${run.plan.objective.replace(/[\r\n]/g, " ").slice(0, 100)}`,
      "-m",
      `Graph-Run-Id: ${run.id}`,
    ]);
    commit = await checkedGit(run.workspace, ["rev-parse", "HEAD"]);
  } else {
    // A prior attempt may have committed/pushed before the process or PR call failed.
    const message = await checkedGit(run.workspace, [
      "log",
      "-1",
      "--format=%B",
    ]);
    if (message.split("\n").includes(`Graph-Run-Id: ${run.id}`))
      commit = await checkedGit(run.workspace, ["rev-parse", "HEAD"]);
    else if (run.commit)
      throw new Error(
        "The recorded run commit is no longer at the workspace HEAD",
      );
    else return {};
  }
  if (run.commit && run.commit !== commit && !changes.stdout.length)
    throw new Error(
      "The recorded run commit does not match the workspace HEAD",
    );
  await assertVerified();
  if (config.policy.publication === "commit") return { commit };
  await checkedGit(run.workspace, [
    "push",
    "--",
    config.github!.remote,
    `HEAD:refs/heads/${run.branch}`,
  ]);
  cancelled();
  // Qualify the host so inherited GH_HOST cannot reroute task text.
  const qualifiedRepository = `github.com/${repository}`;
  const existing = await command(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      qualifiedRepository,
      "--head",
      run.branch,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      ".[0].url",
    ],
    { cwd: root, signal },
  );
  if (existing.code !== 0)
    throw new Error("Cannot reconcile existing pull requests");
  if (existing.stdout.trim())
    return { commit, pullRequest: existing.stdout.trim() };
  cancelled();
  const bodyFile = path.join(path.dirname(run.workspace), `${run.id}-pr.md`);
  await writeFile(
    bodyFile,
    `Implements: ${run.plan.objective}\n\nAcceptance criteria:\n${run.plan.acceptance.map((a) => `- ${a}`).join("\n")}\n\nAutomated verification completed for this run. Review the changes before merging.\n\nGraph Engineering run: ${run.id}\n`,
    { mode: 0o600 },
  );
  const pullRequest = await checked(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      qualifiedRepository,
      "--base",
      config.github!.baseBranch,
      "--head",
      run.branch,
      "--draft",
      "--title",
      run.plan.objective.slice(0, 200),
      "--body-file",
      bodyFile,
    ],
    { cwd: root, signal },
  );
  return { commit, pullRequest };
}
