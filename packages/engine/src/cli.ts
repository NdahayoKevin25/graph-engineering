#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  assertProjectConfig,
  type ProviderConfig,
  type ProjectPolicy,
} from "@graph-engineering/contracts";
import { GraphEngine } from "./service.js";
import {
  configureProvider,
  initializeProject,
  loadProject,
  loadProviders,
  PROJECT_FILE,
  projectDataDir,
} from "./project.js";
import { readJson, writeJson, errorMessage } from "./util.js";
import { createServer } from "./server.js";
import { serveMcp } from "./mcp.js";
import { listTemplates, scaffold, validateArtifacts } from "./templates.js";
import {
  canPromote,
  evaluateDecisions,
  type EvaluationRow,
} from "./decisions.js";
import { discoverInstalledWorkers } from "./workers/installed.js";

const cli = new Command()
  .name("graph-engine")
  .description("Local context, engineering memory, and controlled coding runs")
  .version("0.1.0")
  .option("-C, --project <path>", "Project root", process.cwd());
const root = () => path.resolve(cli.opts().project);
const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};
async function withEngine(fn: (engine: GraphEngine) => Promise<unknown>) {
  const engine = await GraphEngine.open(root());
  try {
    print(await fn(engine));
  } finally {
    await engine.close();
  }
}

cli
  .command("init")
  .option("--name <name>")
  .action(async (options) =>
    print(await initializeProject(root(), options.name)),
  );
cli
  .command("index")
  .action(() => withEngine((engine) => engine.context.index()));
cli
  .command("embeddings-provision")
  .description(
    "Explicitly download pinned local embeddings; project network policy must permit model distribution hosts",
  )
  .action(() => withEngine((engine) => engine.context.provisionEmbeddings()));
cli
  .command("context <query>")
  .option("--budget <tokens>", "Context token ceiling", (v) => Number(v))
  .action((query, options) =>
    withEngine((engine) =>
      engine.context.getContext({ query, budgetTokens: options.budget }),
    ),
  );
cli
  .command("symbols <query>")
  .action((query) =>
    withEngine((engine) => engine.context.searchSymbols(query)),
  );
cli.command("templates").action(async () => print(await listTemplates()));
cli
  .command("validate-graph <artifacts>")
  .description(
    "Validate fine-grained graph artifacts, bindings, dependency order, and manifests",
  )
  .action(async (artifacts) => {
    const result = await validateArtifacts(path.resolve(artifacts));
    print(result);
    if (!(result as { valid: boolean }).valid) process.exitCode = 1;
  });
cli
  .command("scaffold <config> <target>")
  .option("--write", "Write a new project (default previews only)")
  .action(async (config, target, options) =>
    print(
      scaffold(
        await readJson(path.resolve(config)),
        path.resolve(target),
        !options.write,
      ),
    ),
  );
cli
  .command("policy")
  .option("--file <json>", "Replace project policy from a reviewed JSON file")
  .action(async (options) => {
    const project = await loadProject(root());
    if (options.file) {
      project.policy = await readJson<ProjectPolicy>(
        path.resolve(options.file),
      );
      assertProjectConfig(project);
      await writeJson(path.join(root(), PROJECT_FILE), project);
    }
    print(project.policy);
  });
cli
  .command("check-add <image> <argv...>")
  .description(
    "Register a verification command, run with network disabled in a provisioned image",
  )
  .allowUnknownOption()
  .action(async (image, argv) => {
    const project = await loadProject(root());
    project.verification.push({ image, argv });
    assertProjectConfig(project);
    await writeJson(path.join(root(), PROJECT_FILE), project);
    print(project.verification);
  });
cli
  .command("provider-add <id> <kind> <model>")
  .option("--endpoint <url>")
  .option("--key-env <name>")
  .option("--efforts <list>")
  .option(
    "--enable",
    "Allow this provider in project policy; cloud access still requires explicit policy configuration",
  )
  .action(async (id, kind, model, options) => {
    const project = await loadProject(root());
    const provider: ProviderConfig = {
      id,
      kind,
      model,
      endpoint: options.endpoint,
      apiKeyEnv: options.keyEnv,
      efforts: options.efforts?.split(","),
    };
    await configureProvider(projectDataDir(project.projectId), provider);
    if (options.enable) {
      project.policy.providers = [
        ...new Set([...project.policy.providers, id]),
      ];
      assertProjectConfig(project);
      await writeJson(path.join(root(), PROJECT_FILE), project);
    }
    print(provider);
  });
cli.command("providers").action(async () => {
  const project = await loadProject(root());
  print(await loadProviders(projectDataDir(project.projectId)));
});
cli
  .command("capabilities")
  .description("Probe installed coding clients without starting paid inference")
  .action(async () => print(await discoverInstalledWorkers()));
cli
  .command("plan <objective>")
  .requiredOption("--accept <criterion...>", "Acceptance criteria")
  .option("--provider <id>")
  .option("--effort <effort>")
  .action((objective, options) =>
    withEngine((engine) =>
      engine.createPlan({
        objective,
        acceptance: options.accept,
        providerId: options.provider,
        effort: options.effort,
      }),
    ),
  );
cli.command("run <planId>").action((planId) =>
  withEngine(async (engine) => {
    const run = await engine.start(planId);
    process.stderr.write(`Run ${run.id}\n`);
    return engine.wait(run.id);
  }),
);
cli
  .command("runs")
  .action(() => withEngine(async (engine) => engine.store.runs()));
cli.command("inspect <runId>").action((runId) =>
  withEngine(async (engine) => ({
    run: engine.store.run(runId),
    events: engine.store.events(runId),
  })),
);
cli
  .command("cancel <runId>")
  .action((runId) => withEngine(async (engine) => engine.cancel(runId)));
cli
  .command("resume <runId>")
  .option(
    "--reconciled",
    "Acknowledge review of the retained workspace and external effects",
  )
  .action((runId, options) =>
    withEngine(async (engine) => {
      await engine.resume(runId, Boolean(options.reconciled));
      return engine.wait(runId);
    }),
  );
cli
  .command("memory-add <text>")
  .option("--kind <kind>", "Memory category", "observation")
  .action((text, options) =>
    withEngine((engine) =>
      engine.context.createMemory({
        text,
        kind: z
          .enum([
            "observation",
            "decision",
            "requirement",
            "constraint",
            "solution",
          ])
          .parse(options.kind),
      }),
    ),
  );
cli
  .command("memories")
  .action(() => withEngine((engine) => engine.context.listMemories()));
cli
  .command("memory-accept <id>")
  .action((id) => withEngine((engine) => engine.context.acceptMemory(id)));
cli
  .command("memory-share <id>")
  .action((id) => withEngine((engine) => engine.context.promoteMemory(id)));
cli
  .command("memory-import")
  .action(() => withEngine((engine) => engine.context.importSharedMemories()));
cli
  .command("decisions")
  .action(() => withEngine(async (engine) => engine.store.decisions()));
cli
  .command("evaluate <json>")
  .description(
    "Evaluate labeled calibration/held-out outcomes; does not fabricate benchmark results",
  )
  .option("--promote", "Save evidence that passes promotion gates")
  .action(async (file, options) => {
    const rows = await readJson<EvaluationRow[]>(path.resolve(file));
    const report = evaluateDecisions(rows);
    if (options.promote) {
      const project = await loadProject(root());
      await writeJson(
        path.join(projectDataDir(project.projectId), "promotions.json"),
        report.reports.filter(canPromote),
      );
    }
    print(report);
  });
cli
  .command("serve")
  .option("--port <number>", "Loopback port", "4317")
  .action(async (options) => {
    const engine = await GraphEngine.open(root());
    const { app, token } = createServer(engine);
    const address = await app.listen({
      host: "127.0.0.1",
      port: z.coerce.number().int().min(0).max(65535).parse(options.port),
    });
    process.stdout.write(`${address}/#token=${token}\n`);
    const close = async () => {
      await app.close();
      await engine.close();
    };
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
  });
cli
  .command("mcp")
  .option(
    "--client <kind>",
    "Declare whether the consuming model is local or cloud-backed",
    "cloud",
  )
  .option("--allow-run", "Expose managed run start capability")
  .action(async (options) => {
    const engine = await GraphEngine.open(root());
    const server = await serveMcp(engine, {
      client: z.enum(["local", "cloud"]).parse(options.client),
      allowRun: options.allowRun,
    });
    process.once(
      "SIGINT",
      () => void server.close().then(() => engine.close()),
    );
    process.once(
      "SIGTERM",
      () => void server.close().then(() => engine.close()),
    );
  });
cli.parseAsync().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
