import { expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  type ContextPacket,
} from "@graph-engineering/contracts";
import { contextForProvider } from "../src/policy.js";

it("keeps private diagnostic paths out of cloud packets while preserving local diagnostics", () => {
  const packet: ContextPacket = {
    version: "1.0.0",
    projectId: "project-id",
    snapshotId: "snapshot-id",
    query: "safeFunction",
    mandatory: [],
    items: [],
    estimatedTokens: 100,
    budgetTokens: 1000,
    coverage: {
      semantic: false,
      graph: "PRIVATE_GRAPH_CANARY",
      warnings: [
        "private/PRIVATE_PATH_CANARY.ts: syntax errors",
        "Loader failed at /private/PRIVATE_NATIVE_CANARY/native.node",
      ],
    },
  };
  const policy = {
    ...structuredClone(DEFAULT_POLICY),
    inference: "allowlisted" as const,
    network: "allowlisted" as const,
    providers: ["cloud", "local"],
    allowedHosts: ["api.openai.com"],
    exportPaths: ["public/**"],
  };
  const cloud = contextForProvider(
    packet,
    { id: "cloud", kind: "openai", model: "configured" },
    policy,
  );
  expect(JSON.stringify(cloud)).not.toContain("PRIVATE_");
  expect(cloud.coverage.warnings).toContain(
    "Local indexing diagnostics are not exported.",
  );
  expect(cloud.coverage.graph).toContain(
    "limited to explicitly exportable files",
  );
  const local = contextForProvider(
    packet,
    { id: "local", kind: "local", model: "configured" },
    policy,
  );
  expect(local).toBe(packet);
  expect(local.coverage.warnings).toEqual(packet.coverage.warnings);
});
