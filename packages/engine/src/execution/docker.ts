import type {
  ProjectConfig,
  ProjectPolicy,
} from "@graph-engineering/contracts";
import { command, checked, hash } from "../util.js";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { gitFiles } from "./workspace.js";
import { isAllowedPath, safePath } from "../policy.js";

export async function dockerAvailable(): Promise<boolean> {
  try {
    return (
      (
        await command("docker", ["info", "--format", "{{.ServerVersion}}"], {
          timeoutMs: 5000,
        })
      ).code === 0
    );
  } catch {
    return false;
  }
}
export interface VerificationResult {
  argv: string[];
  image: string;
  imageId?: string;
  code: number;
  stdout: string;
  stderr: string;
  snapshotHash: string;
}
export async function verifyInContainer(
  workspace: string,
  checks: ProjectConfig["verification"],
  policy: ProjectPolicy,
  snapshotHash: string,
  signal?: AbortSignal,
): Promise<VerificationResult[]> {
  if (checks.length === 0)
    throw new Error(
      "No verification commands configured; acceptance cannot be established",
    );
  const results: VerificationResult[] = [];
  const view = await mkdtemp(
    path.join(path.dirname(workspace), "verification-"),
  );
  const inputs = new Map<string, string>();
  try {
    for (const relative of await gitFiles(workspace))
      if (isAllowedPath(relative, policy)) {
        try {
          const file = await safePath(workspace, relative, policy);
          const content = await readFile(file);
          const target = path.join(view, relative);
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(file, target);
          inputs.set(relative, hash(content.toString("base64")));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    for (const check of checks) {
      if (signal?.aborted) throw new Error("Run cancelled");
      const imageId = await checked(
        "docker",
        ["image", "inspect", "--format", "{{.Id}}", check.image],
        { timeoutMs: 10000, signal },
      );
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
        throw new Error(
          "Verification image must already be provisioned locally",
        );
      const name = `graph-check-${hash(`${workspace}:${Date.now()}:${check.argv.join(" ")}`).slice(0, 20)}`;
      const stop = () => {
        void command("docker", ["kill", name], { timeoutMs: 5000 }).catch(
          () => {},
        );
      };
      signal?.addEventListener("abort", stop, { once: true });
      try {
        const result = await command(
          "docker",
          [
            "run",
            "--rm",
            "--pull=never",
            "--name",
            name,
            "--network=none",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=256",
            "--memory=4g",
            "--cpus=2",
            // With all capabilities dropped, container root cannot traverse a
            // private (0700) bind mount owned by the Linux host user. Match the
            // owner instead of granting DAC_OVERRIDE or opening private files.
            ...(process.getuid && process.getgid
              ? ["--user", `${process.getuid()}:${process.getgid()}`]
              : []),
            "--mount",
            `type=bind,source=${view},target=/workspace`,
            "--workdir",
            "/workspace",
            "--env",
            "CI=true",
            "--env",
            "HOME=/tmp",
            imageId,
            ...check.argv,
          ],
          { signal, timeoutMs: policy.timeoutSeconds * 1000 },
        );
        results.push({
          ...result,
          argv: check.argv,
          image: check.image,
          imageId,
          snapshotHash,
        });
        if (result.code !== 0) break;
      } finally {
        signal?.removeEventListener("abort", stop);
        await command("docker", ["rm", "-f", name], { timeoutMs: 5000 }).catch(
          () => {},
        );
      }
    }
    for (const [relative, digest] of inputs) {
      try {
        const file = await safePath(view, relative, policy);
        if (hash((await readFile(file)).toString("base64")) !== digest)
          throw new Error(`Verification modified source file ${relative}`);
      } catch {
        throw new Error(`Verification changed a source input: ${relative}`);
      }
    }
    return results;
  } finally {
    await rm(view, { recursive: true, force: true });
  }
}
