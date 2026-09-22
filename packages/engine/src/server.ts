import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { GraphEngine } from "./service.js";
import { dockerAvailable } from "./execution/docker.js";
import { listTemplates } from "./templates.js";
import { discoverInstalledWorkers } from "./workers/installed.js";

export function createServer(
  engine: GraphEngine,
  token = randomBytes(32).toString("hex"),
) {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))
      return reply.code(403).send({ error: "Loopback hosts only" });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`)
      return reply.code(403).send({ error: "Cross-origin access denied" });
    if (request.url.startsWith("/api/")) {
      const supplied =
        request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (
        Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        return reply.code(401).send({ error: "Local access token required" });
    }
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store");
  });
  app.setErrorHandler((error, _request, reply) => {
    reply.code(400).send({
      error: error instanceof Error ? error.message : "Request failed",
    });
  });
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/project", async () => ({
    config: await engine.refresh(),
    root: engine.root,
    capabilities: {
      docker: await dockerAvailable(),
      providers: await engine.providers(),
      installedWorkers: await discoverInstalledWorkers(),
    },
  }));
  app.get("/api/snapshots", () => engine.context.listSnapshots());
  app.post("/api/index", async () => {
    await engine.refresh();
    return engine.context.index();
  });
  app.post("/api/context", async (request) => {
    await engine.refresh();
    const input = z
      .object({
        query: z.string().min(1).max(10000),
        budgetTokens: z.number().int().positive().optional(),
        snapshotId: z.string().optional(),
      })
      .strict()
      .parse(request.body);
    return engine.context.getContext(input);
  });
  app.get("/api/symbols", (request) => {
    const q = z
      .object({ q: z.string().default(""), snapshotId: z.string().optional() })
      .parse(request.query);
    return engine.context.searchSymbols(q.q, q.snapshotId);
  });
  app.get("/api/neighbors", (request) => {
    const q = z
      .object({
        symbolId: z.string(),
        snapshotId: z.string().optional(),
        depth: z.coerce.number().int().min(1).max(3).default(1),
      })
      .parse(request.query);
    return engine.context.neighbors(q.symbolId, q.snapshotId, q.depth);
  });
  app.get("/api/memories", () => engine.context.listMemories());
  app.post("/api/memories", (request) =>
    engine.context.createMemory(
      z
        .object({
          text: z.string().min(1).max(16000),
          kind: z.enum([
            "observation",
            "decision",
            "requirement",
            "constraint",
            "solution",
          ]),
        })
        .strict()
        .parse(request.body),
    ),
  );
  app.post("/api/memories/:id/accept", (request) =>
    engine.context.acceptMemory(
      z.object({ id: z.string() }).parse(request.params).id,
    ),
  );
  app.post("/api/memories/:id/promote", (request) =>
    engine.context.promoteMemory(
      z.object({ id: z.string() }).parse(request.params).id,
    ),
  );
  app.get("/api/templates", () => listTemplates());
  app.get("/api/decisions", async () => engine.store.decisions());
  app.get("/api/runs", async () => engine.store.runs());
  app.get("/api/runs/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return { run: engine.store.run(id), events: engine.store.events(id) };
  });
  app.post("/api/plans", (request) =>
    engine.createPlan(
      z
        .object({
          objective: z.string().min(1).max(16000),
          acceptance: z.array(z.string().min(1).max(4000)).min(1).max(50),
          providerId: z.string().optional(),
          effort: z.string().optional(),
        })
        .strict()
        .parse(request.body),
    ),
  );
  app.post("/api/runs", (request) =>
    engine.start(
      z.object({ planId: z.string() }).strict().parse(request.body).planId,
    ),
  );
  app.post("/api/runs/:id/cancel", async (request) =>
    engine.cancel(z.object({ id: z.string() }).parse(request.params).id),
  );
  app.post("/api/runs/:id/resume", (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { reconciled } = z
      .object({ reconciled: z.boolean().default(false) })
      .parse(request.body ?? {});
    return engine.resume(id, reconciled);
  });
  app.get("/api/runs/:id/events", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    engine.store.run(id);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    let sent = 0;
    const flush = () => {
      const events = engine.store.events(id);
      for (const event of events.slice(sent))
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      sent = events.length;
    };
    flush();
    const timer = setInterval(flush, 1000);
    reply.raw.on("close", () => clearInterval(timer));
  });
  const dashboard = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../dashboard/dist",
  );
  if (existsSync(dashboard)) {
    app.register(fastifyStatic, { root: dashboard });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Unknown API route" })
        : reply.sendFile("index.html"),
    );
  } else
    app.get("/", async () => ({
      message:
        "Build the dashboard with npm run build, then restart the server.",
    }));
  return { app, token };
}
