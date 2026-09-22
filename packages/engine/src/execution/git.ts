import { devNull } from "node:os";
import { command, type CommandResult } from "../util.js";

/** Git is metadata plumbing, never a way to execute repository hooks or filters. */
export async function managedGit(
  cwd: string,
  argv: string[],
): Promise<CommandResult> {
  const configured = await command(
    "git",
    [
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ],
    { cwd },
  );
  if (configured.code !== 0 && configured.code !== 1)
    throw new Error("Cannot inspect Git filter configuration");
  const filters = configured.stdout
    .split("\0")
    .filter(Boolean)
    .flatMap((key) => [
      "-c",
      `${key}=${key.endsWith(".required") ? "false" : ""}`,
    ]);
  return command(
    "git",
    [
      "-c",
      `core.hooksPath=${devNull}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "submodule.recurse=false",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "push.gpgSign=false",
      ...filters,
      ...argv,
    ],
    { cwd },
  );
}
export async function checkedGit(cwd: string, argv: string[]): Promise<string> {
  const result = await managedGit(cwd, argv);
  if (result.code !== 0)
    throw new Error(
      `git failed (${result.code}): ${result.stderr.trim().slice(0, 1000)}`,
    );
  return result.stdout.trim();
}
