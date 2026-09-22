import { it, expect, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GraphEngine } from "../src/service.js";
import { initializeProject, projectDataDir } from "../src/project.js";
import { createMcpServer } from "../src/mcp.js";

it("serves real indexed context through MCP and refuses cloud export for offline projects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-mcp-"));
  const config = await initializeProject(root);
  await writeFile(
    path.join(root, "math.ts"),
    "export function add(a: number, b: number) { return a + b; }",
  );
  const engine = await GraphEngine.open(root);
  try {
    for (const kind of ["local", "cloud"] as const) {
      const server = createMcpServer(engine, { client: kind });
      const client = new Client({ name: "integration-test", version: "1.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("context_get");
        expect(tools.tools.map((tool) => tool.name)).not.toContain("run_start");
        const result = await client.callTool({
          name: "context_get",
          arguments: { query: "add", budgetTokens: 2000 },
        });
        if (kind === "cloud") {
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).toContain("Offline project");
        } else {
          expect(result.isError).not.toBe(true);
          expect(JSON.stringify(result)).toContain("math.ts");
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectDataDir(config.projectId), {
      recursive: true,
      force: true,
    });
  }
});

it("cloud MCP omits private diagnostics and credential-bearing symbols and graph targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-mcp-export-"));
  const config = await initializeProject(root);
  config.policy.inference = "allowlisted";
  config.policy.network = "allowlisted";
  config.policy.allowedHosts = ["api.openai.com"];
  config.policy.exportPaths = ["public/**"];
  await writeFile(
    path.join(root, ".graph", "project.json"),
    JSON.stringify(config),
  );
  await mkdir(path.join(root, "public"));
  await mkdir(path.join(root, "private"));
  await writeFile(
    path.join(root, "public", "safe.ts"),
    "export function safeFunction() { return true; }",
  );
  await writeFile(
    path.join(root, "public", "auth.ts"),
    "export function login(password: string) { return Boolean(password); }",
  );
  await writeFile(path.join(root, "public", "imports.ts"), 'import "./safe";');
  await writeFile(
    path.join(root, "private", "MCP_PRIVATE_PATH_CANARY.ts"),
    "export function broken( { >>>",
  );
  const engine = await GraphEngine.open(root);
  try {
    const snapshot = await engine.context.index();
    expect(
      snapshot.coverage.errors.some((error) =>
        error.includes("MCP_PRIVATE_PATH_CANARY"),
      ),
    ).toBe(true);
    const importsFile = (
      await engine.context.searchSymbols("public/imports.ts")
    )[0]!;
    expect(importsFile).toBeDefined();
    // Historical index records can predate strengthened ingestion filters.
    // Verify the cloud boundary scans raw text itself, including double quotes
    // that would become escaped (and miss assignment patterns) in JSON text.
    const searchSymbols = engine.context.searchSymbols.bind(engine.context);
    const neighbors = engine.context.neighbors.bind(engine.context);
    vi.spyOn(engine.context, "searchSymbols").mockImplementation(
      async (...args) =>
        (await searchSymbols(...args)).map((symbol) =>
          symbol.name === "login"
            ? {
                ...symbol,
                signature:
                  'function login(password = "MCP_SYMBOL_CANARY_123456789012")',
              }
            : symbol,
        ),
    );
    vi.spyOn(engine.context, "neighbors").mockImplementation(async (...args) =>
      (await neighbors(...args)).map((edge) =>
        edge.kind === "imports" && edge.source.path === "public/imports.ts"
          ? {
              ...edge,
              target:
                'import "./internal?api_key=MCP_EDGE_CANARY_123456789012";',
            }
          : edge,
      ),
    );
    for (const kind of ["local", "cloud"] as const) {
      const server = createMcpServer(engine, { client: kind });
      const client = new Client({
        name: "export-integration-test",
        version: "1.0.0",
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const packet = await client.callTool({
          name: "context_get",
          arguments: { query: "safeFunction", budgetTokens: 4000 },
        });
        const symbols = await client.callTool({
          name: "symbol_search",
          arguments: { query: "login" },
        });
        const edges = await client.callTool({
          name: "graph_neighbors",
          arguments: { symbolId: importsFile.id },
        });
        for (const result of [packet, symbols, edges])
          expect(result.isError).not.toBe(true);
        expect(JSON.stringify(packet)).toContain("public/safe.ts");
        if (kind === "local") {
          expect(JSON.stringify(packet)).toContain("MCP_PRIVATE_PATH_CANARY");
          expect(JSON.stringify(symbols)).toContain("MCP_SYMBOL_CANARY");
          expect(JSON.stringify(edges)).toContain("MCP_EDGE_CANARY");
        } else {
          expect(JSON.stringify(packet)).not.toContain(
            "MCP_PRIVATE_PATH_CANARY",
          );
          expect(JSON.stringify(symbols)).not.toContain("MCP_SYMBOL_CANARY");
          expect(JSON.stringify(edges)).not.toContain("MCP_EDGE_CANARY");
          expect(JSON.stringify(packet)).toContain(
            "Local indexing diagnostics are not exported.",
          );
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectDataDir(config.projectId), {
      recursive: true,
      force: true,
    });
  }
});
