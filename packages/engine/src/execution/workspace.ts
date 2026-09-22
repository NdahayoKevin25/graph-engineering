import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { ProjectPolicy } from "@graph-engineering/contracts";
import type { WorkerProposal } from "../workers/api.js";
import { hash } from "../util.js";
import { checkedGit, managedGit } from "./git.js";
import { containsSecret, isAllowedPath, safePath } from "../policy.js";

export async function gitFiles(root: string): Promise<string[]> {
  const result = await managedGit(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (result.code !== 0)
    throw new Error("Managed execution requires a Git repository");
  return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
}
export async function createWorkspace(
  root: string,
  dataDir: string,
  runId: string,
  policy: ProjectPolicy,
): Promise<{ workspace: string; branch: string }> {
  const workspace = path.join(dataDir, "workspaces", runId);
  const branch = `graph/${runId}`;
  await mkdir(path.dirname(workspace), { recursive: true });
  let exists = false;
  try {
    exists = (await stat(workspace)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exists) {
    // Recover a process interruption after worktree creation but before its
    // location was persisted. Never adopt another repository or branch.
    const sourceCommon = await checkedGit(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const runCommon = await checkedGit(workspace, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (
      (await realpath(sourceCommon)) !== (await realpath(runCommon)) ||
      (await checkedGit(workspace, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ])) !== branch
    )
      throw new Error("Existing run workspace needs manual reconciliation");
  } else {
    const existingBranch = await managedGit(root, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (existingBranch.code === 0) {
      if (
        (await checkedGit(root, ["rev-parse", branch])) !==
        (await checkedGit(root, ["rev-parse", "HEAD"]))
      )
        throw new Error("Existing run branch needs manual reconciliation");
      await checkedGit(root, ["worktree", "add", workspace, branch]);
    } else if (existingBranch.code === 1)
      await checkedGit(root, [
        "worktree",
        "add",
        "-b",
        branch,
        workspace,
        "HEAD",
      ]);
    else throw new Error("Cannot inspect execution branch");
  }
  // Capture permitted dirty/untracked files without stashing or modifying the user's worktree.
  for (const relative of await gitFiles(root)) {
    if (!isAllowedPath(relative, policy)) continue;
    try {
      const source = await safePath(root, relative, policy);
      const target = await safePath(workspace, relative, policy);
      if ((await stat(source)).isFile()) {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // An existing dirty deletion needs to remain a deletion in the snapshot.
  const deleted = await checkedGit(root, ["ls-files", "-d", "-z"]);
  const { unlink } = await import("node:fs/promises");
  for (const relative of deleted.split("\0").filter(Boolean))
    if (isAllowedPath(relative, policy)) {
      try {
        await unlink(await safePath(workspace, relative, policy));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  return { workspace, branch };
}
export async function applyProposal(
  workspace: string,
  proposal: WorkerProposal,
  policy: ProjectPolicy,
): Promise<string[]> {
  const staged = new Map<string, { absolute: string; content: string }>();
  for (const change of proposal.changes) {
    const absolute = await safePath(workspace, change.path, policy);
    let content = staged.get(change.path)?.content;
    if (content === undefined) {
      try {
        content = await readFile(absolute, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (change.before === null) {
      if (content !== undefined)
        throw new Error(
          `Refusing to replace existing file ${change.path} with a creation`,
        );
      content = change.after;
    } else {
      if (
        content === undefined ||
        !change.before ||
        content.split(change.before).length !== 2
      )
        throw new Error(
          `Patch precondition failed: ${change.path} must contain exactly one matching substring`,
        );
      content = content.replace(change.before, () => change.after);
    }
    if (containsSecret(content))
      throw new Error(`Patch includes a potential secret in ${change.path}`);
    staged.set(change.path, { absolute, content });
  }
  // Validate the complete proposal before making any writes.
  for (const { absolute, content } of staged.values()) {
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return [...staged.keys()];
}
export async function workspaceFingerprint(
  workspace: string,
  policy: ProjectPolicy,
): Promise<string> {
  const pieces: string[] = [];
  for (const relative of await gitFiles(workspace))
    if (isAllowedPath(relative, policy)) {
      try {
        const file = await safePath(workspace, relative, policy);
        const info = await stat(file);
        if (info.isFile())
          pieces.push(
            `${relative}\0${hash((await readFile(file)).toString("base64"))}\0${info.mode & 0o111}`,
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  return hash(pieces);
}
export async function listDirectory(
  root: string,
  relative: string,
  policy: ProjectPolicy,
): Promise<string[]> {
  const absolute = await safePath(root, relative, policy);
  return (await readdir(absolute)).filter((name) =>
    isAllowedPath(`${relative}/${name}`, policy),
  );
}
