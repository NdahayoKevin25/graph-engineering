import { it, expect } from "vitest";
import { createServer } from "node:http";
import {
  DEFAULT_POLICY,
  type ContextPacket,
} from "@graph-engineering/contracts";
import { invokeApiWorker } from "../src/workers/api.js";

it("uses a local OpenAI-compatible endpoint and validates its structured patch", async () => {
  let received: any;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        model: "local-fixture",
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Fix",
                changes: [{ path: "sum.js", before: "a-b", after: "a+b" }],
                requests: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const packet: ContextPacket = {
      version: "1.0.0",
      projectId: "project",
      snapshotId: "snapshot",
      query: "fix",
      mandatory: ["tests pass"],
      items: [],
      estimatedTokens: 20,
      budgetTokens: 1000,
      coverage: { semantic: false, graph: "syntactic", warnings: [] },
    };
    const result = await invokeApiWorker({
      provider: {
        id: "local",
        kind: "local",
        model: "fixture",
        endpoint: `http://127.0.0.1:${port}/v1`,
      },
      policy: { ...DEFAULT_POLICY, providers: ["local"] },
      context: packet,
      objective: "Fix sum",
      acceptance: ["sum is correct"],
    });
    expect(result.proposal.changes[0].after).toBe("a+b");
    expect(result.usage.inputTokens).toBe(100);
    expect(received.response_format.type).toBe("json_schema");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
