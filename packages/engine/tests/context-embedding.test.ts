import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ContextEngine } from "../src/context/index.js";

// Explicit opt-in integration test: downloads a pinned ~642 MB ONNX model.
// Normal test/index/retrieval runs never contact the network for embeddings.
it.skipIf(process.env.GRAPH_EMBEDDING_SMOKE !== "1")(
  "provisions fp32 ONNX and retrieves cached semantic neighbors offline",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "graph-embedding-smoke-"));
    const root = join(directory, "repo");
    await mkdir(root);
    await writeFile(
      join(root, "security.ts"),
      "export function authenticateUser(password: string, storedHash: string) { return verifyPasswordHash(password, storedHash); }",
    );
    await writeFile(
      join(root, "colors.ts"),
      "export function mixColors(red: number, blue: number) { return red + blue; }",
    );
    const options = {
      projectId: "embedding-test",
      root,
      dataDir: process.env.GRAPH_EMBEDDING_CACHE_DIR ?? join(directory, "data"),
    };
    const engine = new ContextEngine({
      ...options,
      policy: {
        ...DEFAULT_POLICY,
        network: "allowlisted",
        allowedHosts: [
          "huggingface.co",
          "cas-bridge.xethub.hf.co",
          "cas-bridge.xethub-eu.hf.co",
          "cdn-lfs.huggingface.co",
          "cdn-lfs-us-1.hf.co",
          "cdn-lfs-eu-1.hf.co",
        ],
      },
    });
    let offline: ContextEngine | undefined;
    const started = performance.now();
    try {
      await engine.index();
      await engine.provisionEmbeddings();
      const provisionSeconds = (performance.now() - started) / 1000;
      await engine.close();
      offline = new ContextEngine({ ...options, policy: DEFAULT_POLICY });
      const queryStarted = performance.now();
      const packet = await offline.getContext({
        query: "Check login credentials and protect account access.",
      });
      expect(packet.coverage.semantic).toBe(true);
      expect(packet.items[0]?.source?.path).toBe("security.ts");
      console.log(
        JSON.stringify({
          model: "jina-code-fp32",
          provisionSeconds,
          firstOfflineQuerySeconds: (performance.now() - queryStarted) / 1000,
          maxRssMiB: process.resourceUsage().maxRSS / 1024,
          semantic: packet.coverage.semantic,
        }),
      );
    } finally {
      await engine.close();
      await offline?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  300000,
);
