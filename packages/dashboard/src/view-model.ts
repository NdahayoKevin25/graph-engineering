import type { RunRecord } from "@graph-engineering/contracts";

export const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
export const shortId = (value?: string | null) =>
  value ? value.slice(0, 8) : "Uncommitted";
export const readable = (value: string) => value.replace(/[_-]/g, " ");
export function date(value?: string) {
  if (!value) return "Not yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

export function sumUsage(runs: RunRecord[]) {
  const measured = runs.filter((run) => run.usage.costUsd !== null);
  return {
    cost: measured.length
      ? measured.reduce((total, run) => total + run.usage.costUsd!, 0)
      : null,
    missing: runs.length - measured.length,
    estimated: measured.some((run) => run.usage.estimated),
  };
}

export function getError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

export const activeRun = (status: string) =>
  status === "running" || status === "verifying";
