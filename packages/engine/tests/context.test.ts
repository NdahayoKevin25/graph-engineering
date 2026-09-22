import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ContextEngine } from "../src/context/index.js";

const exec = promisify(execFile);
const directories: string[] = [];
const engines: ContextEngine[] = [];
async function fixture(files: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "graph-context-"));
  directories.push(directory);
  const root = join(directory, "repo");
  await mkdir(root);
  await exec("git", ["init", "-b", "dev", root]);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  const engine = new ContextEngine({
    projectId: "test-project",
    root,
    dataDir: join(directory, "data"),
    policy: structuredClone(DEFAULT_POLICY),
  });
  engines.push(engine);
  return { directory, root, engine };
}
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close().catch(() => {});
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("local context indexing", () => {
  it("excludes case aliases and uses the shared credential scanner", async () => {
    const { engine } = await fixture({
      ".ENV": "PRIVATE_CASE_CANARY",
      ".GrApH/LoCaL/session.ts": "export function privateSession() {}",
      "NoDe_MoDuLeS/dependency.ts": "export function privateDependency() {}",
      "generic.py": 'api_key = "' + "b".repeat(24) + '"',
      "session.ts":
        'export const sessionKey = "' + "ASIA" + "C".repeat(16) + '";',
      "github.ts":
        'export const access = "' + "github_pat_" + "d".repeat(40) + '";',
      "public.ts": "export function visible() {}",
    });
    const snapshot = await engine.index();
    expect(
      (await engine.searchSymbols("", snapshot.id)).map(
        (symbol) => symbol.name,
      ),
    ).toEqual(["public.ts", "visible"]);
    expect(
      snapshot.coverage.errors.filter((error) =>
        error.includes("credential pattern"),
      ),
    ).toHaveLength(3);
    await expect(
      engine.createMemory({
        kind: "observation",
        text: 'password="' + "f".repeat(24) + '"',
      }),
    ).rejects.toThrow("sensitive");
    for (const path of [
      ".git./config",
      ".env ",
      "source.ts:private",
      "CON.txt",
    ]) {
      await expect(
        engine.createMemory({
          kind: "observation",
          text: "An alias must not become source evidence.",
          sources: [
            {
              path,
              startLine: 1,
              endLine: 1,
              contentHash: "x",
              snapshotId: snapshot.id,
            },
          ],
        }),
      ).rejects.toThrow("source");
    }
  });

  it("does not execute configured fsmonitor hooks during read-only indexing", async () => {
    const { engine, root } = await fixture({
      "public.ts": "export function visible() {}",
    });
    const hook = join(root, ".git", "hooks", "context-fsmonitor");
    await writeFile(
      hook,
      '#!/bin/sh\nprintf invoked > .graph-fsmonitor-ran\nprintf "\\0"\n',
    );
    await chmod(hook, 0o700);
    await exec("git", ["-C", root, "config", "core.fsmonitor", hook]);
    const snapshot = await engine.index();
    expect(snapshot.fileCount).toBe(1);
    await expect(
      readFile(join(root, ".graph-fsmonitor-ran"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("parses all launch languages and records unresolved call evidence honestly", async () => {
    const { engine } = await fixture({
      "auth.ts":
        "export function authenticate(token: string) { return verify(token); }",
      "auth.js": "export function authorize(user) { return validate(user); }",
      "auth.py": "def refresh(token):\n    return validate(token)\n",
      "auth.go": "package auth\nfunc Login() { verify() }",
      "auth.rs": "fn revoke() { verify(); }",
      "Auth.java": "class Auth { void login() { verify(); } }",
      "Auth.cs": "class Auth { void Refresh() { Verify(); } }",
    });
    const snapshot = await engine.index();
    expect(snapshot.languages).toEqual([
      "csharp",
      "go",
      "java",
      "javascript",
      "python",
      "rust",
      "typescript",
    ]);
    expect(snapshot.coverage.errors).toEqual([]);
    expect(snapshot.coverage.parsed).toBe(7);
    const symbols = await engine.searchSymbols("authenticate", snapshot.id);
    expect(symbols).toHaveLength(1);
    const neighbors = await engine.neighbors(symbols[0]!.id, snapshot.id);
    expect(neighbors).toContainEqual(
      expect.objectContaining({
        kind: "calls",
        target: "verify",
        to: null,
        evidence: "syntactic",
      }),
    );
    expect(
      neighbors.every((edge) => edge.source.snapshotId === snapshot.id),
    ).toBe(true);
    const packet = await engine.getContext({
      query: "authenticate token",
      snapshotId: snapshot.id,
    });
    expect(packet.items.some((item) => item.source?.path === "auth.ts")).toBe(
      true,
    );
    expect(packet.coverage.semantic).toBe(false);
    expect(
      packet.coverage.warnings.some((warning) =>
        warning.includes("provisioned"),
      ),
    ).toBe(true);
    expect(packet.estimatedTokens).toBeLessThanOrEqual(packet.budgetTokens);
  });

  it("has stable content identity and invalidates dirty, renamed, deleted and branch content", async () => {
    const { engine, root } = await fixture({
      "auth.ts": "export function before() { return true; }",
    });
    const initial = await engine.index();
    expect((await engine.index()).id).toBe(initial.id);
    await writeFile(
      join(root, "auth.ts"),
      "export function after() { return false; }",
    );
    const changed = await engine.index();
    expect(changed.id).not.toBe(initial.id);
    expect(await engine.searchSymbols("before", changed.id)).toEqual([]);
    expect(await engine.searchSymbols("before", initial.id)).toHaveLength(1);
    await exec("git", [
      "-C",
      root,
      "symbolic-ref",
      "HEAD",
      "refs/heads/another-dev",
    ]);
    expect((await engine.index()).id).not.toBe(changed.id);
    await writeFile(join(root, "new.ts"), "export function renamed() {}");
    await rm(join(root, "auth.ts"));
    const renamed = await engine.index();
    expect(await engine.searchSymbols("after", renamed.id)).toEqual([]);
    expect(await engine.searchSymbols("renamed", renamed.id)).toHaveLength(1);
  });

  it("excludes gitignored files, private paths, secrets and external symlinks", async () => {
    const { engine, root, directory } = await fixture({
      ".gitignore": "ignored/\n",
      ".env": "SECRET=PRIVATE_ENV_CANARY",
      "ignored/hidden.ts": "export const PRIVATE_IGNORE_CANARY = true;",
      ".graph/local/session.txt": "PRIVATE_SESSION_CANARY",
      "credentials.json": "PRIVATE_CREDENTIAL_CANARY",
      "leaked.ts": `export const key = '${"sk-" + "a".repeat(40)}';`,
      "public.ts": "export function publicFunction() { return 1; }",
    });
    await writeFile(join(directory, "outside.ts"), "PRIVATE_SYMLINK_CANARY");
    await symlink(join(directory, "outside.ts"), join(root, "linked.ts"));
    const snapshot = await engine.index();
    expect(
      snapshot.coverage.errors.some((error) =>
        error.includes("credential pattern"),
      ),
    ).toBe(true);
    const names = (await engine.searchSymbols("", snapshot.id)).map(
      (symbol) => symbol.name,
    );
    expect(names).toContain("publicFunction");
    for (const path of [
      ".env",
      "ignored/hidden.ts",
      ".graph/local/session.txt",
      "credentials.json",
      "leaked.ts",
      "linked.ts",
    ])
      expect(names).not.toContain(path);
    const bytes = await readFile(join(directory, "data", "context.sqlite"));
    expect(bytes.toString()).not.toContain("PRIVATE_ENV_CANARY");
  });

  it("rejects cross-project databases and snapshots and respects mandatory budgets", async () => {
    const { engine, root, directory } = await fixture({
      "index.ts": 'const hello = "world";',
    });
    await engine.index();
    const wrong = new ContextEngine({
      projectId: "other-project",
      root,
      dataDir: join(directory, "data"),
      policy: DEFAULT_POLICY,
    });
    engines.push(wrong);
    await expect(wrong.listSnapshots()).rejects.toThrow("different project");
    await expect(
      engine.getContext({ query: "hello", snapshotId: "not-owned" }),
    ).rejects.toThrow("does not belong");
    const rule = await engine.createMemory({
      kind: "constraint",
      text: "Never change the public authentication API.",
    });
    await engine.acceptMemory(rule.id);
    const context = await engine.getContext({
      query: "hello",
      budgetTokens: 500,
    });
    expect(context.mandatory).toContain(rule.text);
    expect(context.mandatorySources).toContainEqual({
      text: rule.text,
      visibility: "private",
      sources: [],
    });
    await expect(
      engine.getContext({
        query: "hello",
        budgetTokens: 100,
        mandatory: ["x".repeat(101)],
      }),
    ).rejects.toThrow("Mandatory context");
    await expect(engine.provisionEmbeddings()).rejects.toThrow(
      "explicitly allowed",
    );
  });

  it("preserves syntax error coverage instead of pretending the graph is complete", async () => {
    const { engine } = await fixture({
      "broken.ts": "export function broken( { >>>",
    });
    const snapshot = await engine.index();
    expect(
      snapshot.coverage.errors.some((error) => error.includes("syntax errors")),
    ).toBe(true);
  });

  it("resolves relative imports and expands retrieval to the imported file", async () => {
    const { engine } = await fixture({
      "entry.ts":
        'import { validate } from "./tokens";\nexport function authenticate() { return validate(); }',
      "tokens.ts": 'export function validate() { return "opaque-session"; }',
    });
    const snapshot = await engine.index();
    const entry = (await engine.searchSymbols("entry.ts", snapshot.id))[0]!;
    const edges = await engine.neighbors(entry.id, snapshot.id);
    expect(edges).toContainEqual(
      expect.objectContaining({
        kind: "imports",
        evidence: "resolved",
        to: expect.any(String),
      }),
    );
    const packet = await engine.getContext({
      query: "authenticate",
      snapshotId: snapshot.id,
    });
    expect(packet.items.some((item) => item.source?.path === "tokens.ts")).toBe(
      true,
    );
  });

  it("gives nested calls with the same start position distinct evidence ids", async () => {
    const { engine } = await fixture({
      "nested.ts":
        "export function invoke() { return factory()().map(transform()).filter(Boolean); }",
    });
    const snapshot = await engine.index();
    const symbol = (await engine.searchSymbols("invoke", snapshot.id))[0]!;
    const calls = (await engine.neighbors(symbol.id, snapshot.id)).filter(
      (edge) => edge.kind === "calls",
    );
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(new Set(calls.map((call) => call.id)).size).toBe(calls.length);
    expect((await engine.index()).id).toBe(snapshot.id);
  });

  it("distinguishes two worktrees at the same revision and honors nested ignores outside Git", async () => {
    const { engine, root, directory } = await fixture({
      "index.ts": "export function stable() {}",
    });
    await exec("git", ["-C", root, "add", "index.ts"]);
    await exec("git", [
      "-C",
      root,
      "-c",
      "user.name=Context Test",
      "-c",
      "user.email=context@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const otherRoot = join(directory, "worktree");
    await exec("git", ["-C", root, "worktree", "add", "--detach", otherRoot]);
    const other = new ContextEngine({
      projectId: "test-project",
      root: otherRoot,
      dataDir: join(directory, "data-other"),
      policy: DEFAULT_POLICY,
    });
    engines.push(other);
    const first = await engine.index(),
      second = await other.index();
    expect(first.revision).toBe(second.revision);
    expect(first.worktreeId).not.toBe(second.worktreeId);
    expect(first.id).not.toBe(second.id);
    const plainRoot = join(directory, "plain");
    await mkdir(join(plainRoot, "nested"), { recursive: true });
    await writeFile(join(plainRoot, ".gitignore"), "nested/hidden.ts\n");
    await writeFile(join(plainRoot, "nested", ".gitignore"), "local.ts\n");
    await writeFile(
      join(plainRoot, "nested", "hidden.ts"),
      "const HIDDEN = true;",
    );
    await writeFile(
      join(plainRoot, "nested", "local.ts"),
      "const LOCAL = true;",
    );
    await writeFile(
      join(plainRoot, "nested", "visible.ts"),
      "export function visible() {}",
    );
    const plain = new ContextEngine({
      projectId: "plain-project",
      root: plainRoot,
      dataDir: join(directory, "data-plain"),
      policy: DEFAULT_POLICY,
    });
    engines.push(plain);
    const names = (await plain.searchSymbols("")).map((symbol) => symbol.name);
    expect(names).toContain("visible");
    expect(names).not.toContain("nested/hidden.ts");
    expect(names).not.toContain("nested/local.ts");
  });

  it("serializes concurrent index writers without duplicate evidence", async () => {
    const { engine, root, directory } = await fixture({
      "shared.ts": "export function concurrent() { return 42; }",
    });
    const peer = new ContextEngine({
      projectId: "test-project",
      root,
      dataDir: join(directory, "data"),
      policy: DEFAULT_POLICY,
    });
    engines.push(peer);
    const [first, second] = await Promise.all([engine.index(), peer.index()]);
    expect(first.id).toBe(second.id);
    expect(first.createdAt).toBe(second.createdAt);
    expect(await engine.listSnapshots()).toHaveLength(1);
    const packet = await engine.getContext({
      query: "concurrent",
      snapshotId: first.id,
    });
    expect(packet.items).toHaveLength(1);
  });

  it("applies tightened exclusion policy even to historical retrieval", async () => {
    const { engine } = await fixture({
      "private.ts": "export function authenticateSecretSubsystem() {}",
      "visible.ts": "export function visible() {}",
    });
    const snapshot = await engine.index();
    expect(
      await engine.searchSymbols("authenticateSecretSubsystem", snapshot.id),
    ).toHaveLength(1);
    engine.updatePolicy({
      ...DEFAULT_POLICY,
      excludedPaths: [...DEFAULT_POLICY.excludedPaths, "private.ts"],
    });
    expect(
      await engine.searchSymbols("authenticateSecretSubsystem", snapshot.id),
    ).toHaveLength(0);
    const packet = await engine.getContext({
      query: "authenticateSecretSubsystem",
      snapshotId: snapshot.id,
    });
    expect(packet.items).toHaveLength(0);
  });
});

describe("durable memory", () => {
  it("proposes privately, requires acceptance, shares explicitly and preserves supersession", async () => {
    const { engine, root } = await fixture();
    const first = await engine.createMemory({
      kind: "decision",
      text: "Authentication uses opaque sessions.",
    });
    expect(first.status).toBe("proposed");
    expect(first.visibility).toBe("private");
    await expect(engine.promoteMemory(first.id)).rejects.toThrow("accepted");
    await engine.acceptMemory(first.id);
    const firstExport = await engine.promoteMemory(first.id);
    expect(
      JSON.parse(await readFile(join(root, firstExport.path), "utf8"))
        .visibility,
    ).toBe("shared");
    const second = await engine.createMemory({
      kind: "decision",
      text: "Authentication uses rotating opaque sessions.",
      supersedes: first.id,
    });
    expect(
      (await engine.listMemories()).find((memory) => memory.id === first.id)
        ?.status,
    ).toBe("accepted");
    await engine.acceptMemory(second.id);
    await engine.promoteMemory(second.id);
    expect(
      (await engine.listMemories()).find((memory) => memory.id === first.id)
        ?.status,
    ).toBe("superseded");
    expect(
      (await engine.getContext({ query: "Authentication" })).items.some(
        (item) => item.memoryId === first.id,
      ),
    ).toBe(false);
    const otherData = await mkdtemp(join(tmpdir(), "graph-context-share-"));
    directories.push(otherData);
    const peer = new ContextEngine({
      projectId: "test-project",
      root,
      dataDir: otherData,
      policy: DEFAULT_POLICY,
    });
    engines.push(peer);
    expect(await peer.importSharedMemories()).toBe(2);
    expect(
      (await peer.listMemories()).find((memory) => memory.id === first.id)
        ?.status,
    ).toBe("superseded");
  });

  it("marks conflicting shared content and blocks private or sensitive export", async () => {
    const { engine, root } = await fixture();
    const memory = await engine.createMemory({
      kind: "requirement",
      text: "Preserve all sessions.",
    });
    await engine.acceptMemory(memory.id);
    const exported = await engine.promoteMemory(memory.id);
    await writeFile(
      join(root, exported.path),
      JSON.stringify({ ...exported.record, text: "Delete all sessions." }),
    );
    await engine.importSharedMemories();
    const conflict = (await engine.listMemories())[0]!;
    expect(conflict.status).toBe("conflicted");
    expect(conflict.text).toBe(memory.text);
    await expect(engine.acceptMemory(memory.id)).rejects.toThrow("conflicted");
    await expect(
      engine.createMemory({
        kind: "observation",
        text: "sk-" + "x".repeat(40),
      }),
    ).rejects.toThrow("sensitive");
    await expect(
      engine.createMemory({
        kind: "decision",
        text: "Unsafe source",
        sources: [
          {
            path: "../outside",
            startLine: 1,
            endLine: 1,
            snapshotId: "x",
            contentHash: "y",
          },
        ],
      }),
    ).rejects.toThrow("source");
  });
});
