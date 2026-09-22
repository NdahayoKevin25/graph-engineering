import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GraphEngine } from "../src/service.js";
import { initializeProject, projectDataDir } from "../src/project.js";
import { createServer } from "../src/server.js";

it("requires a local token, rejects hostile origins, and returns real persisted memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-http-"));
  const config = await initializeProject(root);
  const engine = await GraphEngine.open(root);
  const { app } = createServer(engine, "test-token");
  try {
    expect(
      (await app.inject({ url: "/api/health", headers: { host: "localhost" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/health",
          headers: {
            host: "attacker.example",
            authorization: "Bearer test-token",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/health",
          headers: {
            host: "localhost",
            origin: "https://attacker.example",
            authorization: "Bearer test-token",
          },
        })
      ).statusCode,
    ).toBe(403);
    const headers = { host: "localhost", authorization: "Bearer test-token" };
    expect((await app.inject({ url: "/api/health", headers })).json()).toEqual({
      ok: true,
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers,
      payload: { kind: "decision", text: "Use dev for integration" },
    });
    expect(created.statusCode).toBe(200);
    const list = await app.inject({ url: "/api/memories", headers });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].visibility).toBe("private");
  } finally {
    await app.close();
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectDataDir(config.projectId), {
      recursive: true,
      force: true,
    });
  }
});
