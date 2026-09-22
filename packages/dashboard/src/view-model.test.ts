import { describe, expect, it } from "vitest";
import type { RunRecord } from "@graph-engineering/contracts";
import { sumUsage } from "./view-model";

const run = (costUsd: number | null, estimated = false) =>
  ({ usage: { costUsd, estimated } }) as RunRecord;

describe("usage reporting", () => {
  it("does not present absent measurements as zero", () => {
    expect(sumUsage([])).toEqual({ cost: null, missing: 0, estimated: false });
    expect(sumUsage([run(null), run(null)])).toEqual({
      cost: null,
      missing: 2,
      estimated: false,
    });
  });
  it("distinguishes a measured zero from missing and estimated measurements", () => {
    expect(sumUsage([run(0), run(null)])).toEqual({
      cost: 0,
      missing: 1,
      estimated: false,
    });
    expect(sumUsage([run(0.1, true), run(0.2), run(null)])).toEqual({
      cost: expect.closeTo(0.3),
      missing: 1,
      estimated: true,
    });
  });
});
