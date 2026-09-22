import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Build the workspace first. This launcher never uses the user's project/data,
// invokes a model, provisions a model, or starts Docker.
const dashboard = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "graph-dashboard-e2e-"));
const projectRoot = path.join(temporary, "project");
process.env.GRAPH_ENGINE_DATA_DIR = path.join(temporary, "engine-data");
let engine;
let app;
let browserTests;
const stop = () => browserTests?.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const [
    { GraphEngine },
    { initializeProject, configureProvider },
    { createServer },
  ] = await Promise.all([
    import("../../engine/dist/service.js"),
    import("../../engine/dist/project.js"),
    import("../../engine/dist/server.js"),
  ]);
  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  await copyFile(
    path.join(dashboard, "e2e", "fixtures", "project.ts"),
    path.join(projectRoot, "src", "context.ts"),
  );
  await writeFile(
    path.join(projectRoot, "README.md"),
    "# Browser fixture\n\nContext retrieval uses the GraphEngine source class and its rank method.\n",
  );
  const config = await initializeProject(
    projectRoot,
    "Browser smoke workspace",
  );
  config.policy.providers = ["fixture-local"];
  await writeFile(
    path.join(projectRoot, ".graph", "project.json"),
    JSON.stringify(config, null, 2),
  );
  engine = await GraphEngine.open(projectRoot);
  // Plan creation is real and deterministic. This intentionally unreachable
  // local endpoint is never called: fixture checks do not start workers.
  await configureProvider(engine.dataDir, {
    id: "fixture-local",
    kind: "local",
    model: "fixture-no-inference",
    endpoint: "http://127.0.0.1:1/v1",
  });
  await engine.context.index();
  const server = createServer(engine);
  app = server.app;
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const require = createRequire(import.meta.url);
  const cli = require.resolve("@playwright/test/cli");
  console.log(
    "Running browser checks against an isolated temporary engine (no inference).",
  );
  const code = await new Promise((resolve, reject) => {
    browserTests = spawn(
      process.execPath,
      [cli, "test", ...process.argv.slice(2)],
      {
        cwd: dashboard,
        stdio: "inherit",
        env: {
          ...process.env,
          GRAPH_E2E_URL: address,
          GRAPH_E2E_TOKEN: server.token,
          GRAPH_E2E_FIXTURE: "1",
          GRAPH_E2E_QUERY: "context retrieval engine",
          GRAPH_E2E_SYMBOL: "GraphEngine",
        },
      },
    );
    browserTests.once("error", reject);
    browserTests.once("exit", (exitCode, signal) =>
      resolve(exitCode ?? (signal ? 130 : 1)),
    );
  });
  process.exitCode = code;
} catch (error) {
  console.error(
    "Browser fixture failed. Build the workspace and install Playwright Chromium first.",
  );
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  try {
    if (app) await app.close();
  } finally {
    try {
      if (engine) await engine.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
