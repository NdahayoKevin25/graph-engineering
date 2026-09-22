import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { proposalJsonSchema, type WorkerInput } from "../src/workers/api.js";

const mocks = vi.hoisted(() => ({ command: vi.fn(), spawn: vi.fn() }));
vi.mock("../src/util.js", () => ({ command: mocks.command }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
import {
  discoverInstalledWorkers,
  invokeInstalledWorker,
} from "../src/workers/installed.js";

const proposal = {
  summary: "Make the return value true",
  changes: [
    { path: "src/example.ts", before: "return false", after: "return true" },
  ],
  requests: [],
};
const flags =
  "--bare --tools --disallowedTools --strict-mcp-config --mcp-config --setting-sources --settings --disable-slash-commands --no-session-persistence --system-prompt --json-schema --output-format --restricted --safe-mode";
let restrictedCodex = true;
let nativeResult: any;
let nativeExit = 0;
let transportMode:
  | "normal"
  | "wrong-sandbox"
  | "tool"
  | "pending"
  | "feature-enabled"
  | "approval" = "normal";
let rpcRequests: any[] = [];
let nativeCalls: any[] = [];
let child: any;

function input(kind: "claude" | "codex" | "cursor" = "claude"): WorkerInput {
  return {
    provider: { id: "native", kind, model: "fixture-model", efforts: ["low"] },
    effort: "low",
    policy: {
      ...structuredClone(DEFAULT_POLICY),
      inference: "allowlisted",
      network: "allowlisted",
      providers: ["native"],
      exportPaths: ["src/**"],
      allowedHosts: ["api.anthropic.com", "api.openai.com", "chatgpt.com"],
    },
    objective: "Fix the boolean",
    acceptance: ["Return true"],
    context: {
      version: "1.0.0",
      projectId: "project-test",
      snapshotId: "snapshot-test",
      query: "boolean",
      mandatory: ["Preserve public API"],
      items: [
        {
          id: "public",
          kind: "code",
          text: "return false",
          score: 1,
          source: {
            path: "src/example.ts",
            startLine: 1,
            endLine: 1,
            contentHash: "hash",
            snapshotId: "snapshot-test",
          },
        },
        {
          id: "private",
          kind: "code",
          text: "PRIVATE_CONTEXT_CANARY",
          score: 1,
          source: {
            path: ".env",
            startLine: 1,
            endLine: 1,
            contentHash: "hash",
            snapshotId: "snapshot-test",
          },
        },
      ],
      estimatedTokens: 20,
      budgetTokens: 16000,
      coverage: { semantic: false, graph: "syntactic", warnings: [] },
    },
  };
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-native-api-key");
  vi.stubEnv("UNRELATED_PRIVATE_CREDENTIAL", "should-not-be-inherited");
  restrictedCodex = true;
  nativeExit = 0;
  rpcRequests = [];
  nativeCalls = [];
  transportMode = "normal";
  nativeResult = {
    type: "result",
    subtype: "success",
    structured_output: proposal,
    usage: { input_tokens: 80, output_tokens: 50, cache_read_input_tokens: 15 },
    total_cost_usd: 0.012,
  };
  mocks.command
    .mockReset()
    .mockImplementation(
      async (executable: string, argv: string[], options: any) => {
        if (argv[0] === "--version")
          return {
            code: 0,
            stdout:
              executable === "claude" ? "2.1.278 (Claude Code)" : "0.155.1",
            stderr: "",
          };
        if (argv[0] === "--help") return { code: 0, stdout: flags, stderr: "" };
        if (argv.includes("generate-json-schema")) {
          const root = argv[argv.indexOf("--out") + 1];
          await mkdir(path.join(root, "v2"));
          await writeFile(
            path.join(root, "v2", "TurnStartParams.json"),
            JSON.stringify({
              definitions: {
                SandboxPolicy: {
                  oneOf: [
                    {
                      properties: {
                        type: { enum: ["readOnly"] },
                        ...(restrictedCodex
                          ? {
                              access: {
                                oneOf: [
                                  {
                                    properties: {
                                      type: { const: "restricted" },
                                      readableRoots: { type: "array" },
                                    },
                                  },
                                ],
                              },
                            }
                          : {}),
                      },
                    },
                  ],
                },
              },
            }),
          );
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv[0] === "features")
          return {
            code: 0,
            stdout: [
              "shell_tool",
              "unified_exec",
              "shell_snapshot",
              "hooks",
              "multi_agent",
              "apps",
              "plugins",
              "browser_use",
              "computer_use",
              "image_generation",
              "code_mode",
              "code_mode_host",
              "view_image",
              "memories",
              "skill_mcp_dependency_install",
            ]
              .map((f) => `${f} stable true`)
              .join("\n"),
            stderr: "",
          };
        nativeCalls.push({ executable, argv, options });
        return {
          code: nativeExit,
          stdout: JSON.stringify(nativeResult),
          stderr: "sensitive native stderr",
        };
      },
    );
  mocks.spawn
    .mockReset()
    .mockImplementation((_executable: string, argv: string[], options: any) => {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit("close", 0));
        return true;
      });
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          const request = JSON.parse(String(chunk));
          rpcRequests.push(request);
          const emit = (message: unknown) =>
            child.stdout.write(`${JSON.stringify(message)}\n`);
          queueMicrotask(() => {
            let result: any = {};
            if (request.method === "config/read")
              result = {
                config: {
                  mcp_servers: {
                    privateConnector: { command: "must-never-run" },
                  },
                },
              };
            if (request.method === "configRequirements/read")
              result = { requirements: null };
            if (request.method === "experimentalFeature/list")
              result = {
                data: argv.flatMap((arg, i) =>
                  arg === "--disable"
                    ? [
                        {
                          name: argv[i + 1],
                          enabled: transportMode === "feature-enabled",
                        },
                      ]
                    : [],
                ),
                nextCursor: null,
              };
            if (request.method === "model/list")
              result = {
                data: [
                  {
                    id: "fixture-model",
                    model: "fixture-model",
                    supportedReasoningEfforts: [{ reasoningEffort: "low" }],
                  },
                ],
                nextCursor: null,
              };
            if (request.method === "thread/start")
              result = {
                thread: { id: "thread-fixture" },
                sandbox: {
                  type:
                    transportMode === "wrong-sandbox"
                      ? "dangerFullAccess"
                      : "readOnly",
                  networkAccess: false,
                },
                approvalPolicy: "never",
                instructionSources: [],
                model: "fixture-model",
              };
            if (request.id !== undefined && request.method)
              emit({ id: request.id, result });
            if (request.method === "turn/start") {
              if (transportMode === "pending") return;
              if (transportMode === "tool") {
                emit({
                  method: "item/started",
                  params: {
                    threadId: "thread-fixture",
                    item: { type: "commandExecution" },
                  },
                });
                return;
              }
              if (transportMode === "approval")
                emit({
                  id: 999,
                  method: "item/commandExecution/requestApproval",
                  params: { threadId: "thread-fixture" },
                });
              emit({
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: "thread-fixture",
                  tokenUsage: {
                    total: {
                      inputTokens: 120,
                      outputTokens: 40,
                      cachedInputTokens: 12,
                    },
                  },
                },
              });
              emit({
                method: "item/completed",
                params: {
                  threadId: "thread-fixture",
                  item: {
                    type: "agentMessage",
                    phase: "final_answer",
                    text: JSON.stringify(proposal),
                  },
                },
              });
              emit({
                method: "turn/completed",
                params: {
                  threadId: "thread-fixture",
                  turn: { status: "completed" },
                },
              });
            }
          });
          callback();
        },
      });
      nativeCalls.push({ executable: "codex", argv, options });
      return child;
    });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("installed capability discovery", () => {
  it("reports authentication and confinement limits without invoking a model", async () => {
    const capabilities = await discoverInstalledWorkers();
    expect(capabilities.find((c) => c.kind === "claude")).toMatchObject({
      installed: true,
      available: true,
      authentication: "api-key",
      supportsSubscription: false,
    });
    expect(capabilities.find((c) => c.kind === "codex")).toMatchObject({
      available: true,
      authentication: "native-login",
    });
    expect(capabilities.find((c) => c.kind === "cursor")).toMatchObject({
      available: false,
    });
    expect(nativeCalls).toEqual([]);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("does not mistake full read-only access for restricted read access", async () => {
    restrictedCodex = false;
    const capabilities = await discoverInstalledWorkers();
    expect(capabilities.find((c) => c.kind === "codex")).toMatchObject({
      available: false,
      reason: expect.stringContaining("readableRoots"),
    });
  });
  it("handles missing native executables without installing anything", async () => {
    mocks.command.mockRejectedValue(new Error("ENOENT"));
    expect(
      (await discoverInstalledWorkers()).every(
        (c) => !c.installed && !c.available,
      ),
    ).toBe(true);
  });
});

describe("native Claude proposals", () => {
  it("launches bare, zero-tools in empty scratch with only exportable context and selected credential", async () => {
    const result = await invokeInstalledWorker(input(), "/a/real/repository");
    expect(result.proposal).toEqual(proposal);
    expect(result.usage).toEqual({
      inputTokens: 80,
      outputTokens: 50,
      cachedTokens: 15,
      costUsd: 0.012,
      estimated: false,
    });
    const run = nativeCalls[0];
    expect(run.options.cwd).not.toBe("/a/real/repository");
    expect(run.argv).toContain("--bare");
    expect(run.argv[run.argv.indexOf("--tools") + 1]).toBe("");
    expect(run.argv).toContain("--strict-mcp-config");
    expect(run.argv).toContain("--no-session-persistence");
    expect(run.options.input).not.toContain("PRIVATE_CONTEXT_CANARY");
    expect(run.options.env.UNRELATED_PRIVATE_CREDENTIAL).toBeUndefined();
    expect(run.options.env.ANTHROPIC_API_KEY).toBe("test-native-api-key");
    expect(run.argv).not.toContain("test-native-api-key");
    await expect(access(run.options.cwd)).rejects.toThrow();
  });
  it("preserves unknown usage rather than fabricating zeros", async () => {
    delete nativeResult.usage;
    delete nativeResult.total_cost_usd;
    expect((await invokeInstalledWorker(input())).usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      costUsd: null,
      estimated: false,
    });
  });
  it("rejects native errors without leaking stderr and cleans the scratch directory", async () => {
    nativeExit = 1;
    await expect(invokeInstalledWorker(input())).rejects.toThrow(
      "exited with code 1",
    );
    await expect(access(nativeCalls[0].options.cwd)).rejects.toThrow();
  });
  it("does not fall back from missing API credentials to a subscription", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(invokeInstalledWorker(input())).rejects.toThrow(
      "cannot reuse subscription",
    );
    expect(nativeCalls).toEqual([]);
  });
  it("rejects malformed proposals and declared unsuccessful results", async () => {
    nativeResult.structured_output = { summary: "invented success" };
    await expect(invokeInstalledWorker(input())).rejects.toThrow();
    nativeResult = {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
    };
    await expect(invokeInstalledWorker(input())).rejects.toThrow(
      "successful structured proposal",
    );
  });
  it("rejects offline policy, cost caps, unsupported effort and secrets before inference", async () => {
    const offline = input();
    offline.policy.inference = "local";
    await expect(invokeInstalledWorker(offline)).rejects.toThrow("Offline");
    const capped = input();
    capped.policy.maxCostUsd = 1;
    await expect(invokeInstalledWorker(capped)).rejects.toThrow("cost budget");
    const unsupported = input();
    unsupported.effort = "ultra";
    await expect(invokeInstalledWorker(unsupported)).rejects.toThrow(
      "Unsupported effort",
    );
    const secret = input();
    secret.feedback = "api_key=abcdefghijklmnopqrstuvwx";
    await expect(invokeInstalledWorker(secret)).rejects.toThrow(
      "potential secret",
    );
    expect(nativeCalls).toEqual([]);
  });
  it("forwards cancellation and bounded timeout/output settings without putting the task in argv", async () => {
    const request = input(),
      abort = new AbortController();
    request.signal = abort.signal;
    await invokeInstalledWorker(request);
    expect(nativeCalls[0].options).toMatchObject({
      signal: abort.signal,
      timeoutMs: 600000,
      maxBytes: 2000000,
    });
    expect(nativeCalls[0].argv).not.toContain(request.objective);
    abort.abort();
    await expect(invokeInstalledWorker(request)).rejects.toThrow();
  });
});

describe("Codex restricted-read proposals", () => {
  it("passes output schema and restricted roots, disables MCP/features, and never hands over the repository", async () => {
    const result = await invokeInstalledWorker(
      input("codex"),
      "/a/real/repository",
    );
    expect(result.proposal).toEqual(proposal);
    expect(result.usage.costUsd).toBeNull();
    expect(result.usage.inputTokens).toBe(120);
    const start = rpcRequests.find((r) => r.method === "thread/start");
    expect(start.params.config.mcp_servers.privateConnector.enabled).toBe(
      false,
    );
    expect(start.params.dynamicTools).toEqual([]);
    const turn = rpcRequests.find((r) => r.method === "turn/start");
    expect(turn.params.outputSchema).toEqual(proposalJsonSchema);
    expect(turn.params.sandboxPolicy).toEqual({
      type: "readOnly",
      networkAccess: false,
      access: {
        type: "restricted",
        includePlatformDefaults: true,
        readableRoots: [nativeCalls[0].options.cwd],
      },
    });
    expect(JSON.stringify(rpcRequests)).not.toContain("/a/real/repository");
    expect(JSON.stringify(rpcRequests)).not.toContain("PRIVATE_CONTEXT_CANARY");
    expect(
      rpcRequests.some((r) =>
        /^(fs\/|process\/|thread\/shellCommand|config\/value\/write)/.test(
          r.method,
        ),
      ),
    ).toBe(false);
    await expect(access(nativeCalls[0].options.cwd)).rejects.toThrow();
  });
  it("refuses native protocols that silently ignore restricted-access fields", async () => {
    restrictedCodex = false;
    await expect(invokeInstalledWorker(input("codex"))).rejects.toThrow(
      "readableRoots",
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("refuses downgraded sandbox permissions before submitting a paid turn", async () => {
    transportMode = "wrong-sandbox";
    await expect(invokeInstalledWorker(input("codex"))).rejects.toThrow(
      "effective thread permissions",
    );
    expect(rpcRequests.some((r) => r.method === "turn/start")).toBe(false);
  });
  it("refuses a native runtime that did not disable a required feature", async () => {
    transportMode = "feature-enabled";
    await expect(invokeInstalledWorker(input("codex"))).rejects.toThrow(
      "did not disable",
    );
    expect(rpcRequests.some((r) => r.method === "thread/start")).toBe(false);
  });
  it("never accepts tool execution as a patch proposal", async () => {
    transportMode = "tool";
    await expect(invokeInstalledWorker(input("codex"))).rejects.toThrow(
      "tool operation",
    );
    expect(child.kill).toHaveBeenCalled();
  });
  it("declines server-side approval requests without invoking an executor", async () => {
    transportMode = "approval";
    await invokeInstalledWorker(input("codex"));
    expect(rpcRequests.find((r) => r.id === 999)).toEqual({
      id: 999,
      result: { decision: "decline" },
    });
    expect(nativeCalls).toHaveLength(1);
  });
  it("cancels a stalled native turn and cleans scratch state", async () => {
    transportMode = "pending";
    const request = input("codex"),
      controller = new AbortController();
    request.signal = controller.signal;
    const running = invokeInstalledWorker(request);
    const rejected = expect(running).rejects.toThrow("cancelled");
    await vi.waitFor(() =>
      expect(rpcRequests.some((r) => r.method === "turn/start")).toBe(true),
    );
    controller.abort();
    await rejected;
    expect(child.kill).toHaveBeenCalled();
    await expect(access(nativeCalls[0].options.cwd)).rejects.toThrow();
  });
});
