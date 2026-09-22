import { useState } from "react";
import type { DecisionRecord, RunRecord } from "@graph-engineering/contracts";
import type { Api } from "./api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Icon,
  Loading,
  PageHeading,
  Status,
  useResource,
} from "./components";
import { date, number, readable, sumUsage } from "./view-model";

export function DecisionsPage({ api, active }: { api: Api; active: boolean }) {
  const decisions = useResource<DecisionRecord[]>(
    api,
    active ? "/api/decisions" : null,
  );
  const runs = useResource<RunRecord[]>(api, active ? "/api/runs" : null);
  const [mode, setMode] = useState("all");
  const [category, setCategory] = useState("all");
  const records = decisions.data ?? [];
  const categories = Array.from(
    new Set(records.map((record) => record.category)),
  ).sort();
  const filtered = records
    .filter(
      (record) =>
        (mode === "all" || record.mode === mode) &&
        (category === "all" || record.category === category),
    )
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const usage = sumUsage(runs.data ?? []);
  return (
    <>
      <PageHeading
        eyebrow="DECISIONS & USAGE"
        title="See why a path was chosen."
        action={
          <Button
            variant="secondary"
            onClick={() => {
              decisions.reload();
              runs.reload();
            }}
          >
            <Icon name="refresh" size={16} />
            Refresh
          </Button>
        }
      >
        Inspect the choices behind the work, and the usage providers actually
        report.
      </PageHeading>
      <ErrorNotice message={decisions.error} retry={decisions.reload} />
      <ErrorNotice message={runs.error} retry={runs.reload} />
      <div className="metric-grid">
        <div className="metric">
          <span className="metric-label">
            Recorded decisions <Icon name="decision" size={16} />
          </span>
          <strong>{decisions.data ? number(records.length) : "—"}</strong>
          <span className="metric-foot">
            {records.filter((record) => record.mode === "shadow").length}{" "}
            observed in shadow mode
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">
            Promoted decisions <Icon name="check" size={16} />
          </span>
          <strong>
            {decisions.data
              ? number(
                  records.filter((record) => record.mode === "promoted").length,
                )
              : "—"}
          </strong>
          <span className="metric-foot">
            Categories enabled by project policy
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">
            {usage.estimated ? "Known estimated cost" : "Known reported cost"}
            <Icon name="run" size={16} />
          </span>
          <strong>
            {usage.cost === null ? "—" : `$${usage.cost.toFixed(4)}`}
          </strong>
          <span className="metric-foot">
            {usage.missing
              ? `${usage.missing} run${usage.missing === 1 ? "" : "s"} with unreported cost`
              : runs.data?.length
                ? "Across runs that reported cost"
                : "No usage has been reported"}
          </span>
        </div>
      </div>
      <div className="notice notice-subtle">
        <Icon name="shield" size={18} />
        <span>
          Shadow decisions are observations. Model confidence does not establish
          correctness, and missing usage is never counted as zero.
        </span>
      </div>
      <div className="section-toolbar">
        <div
          className="filter-tabs"
          role="group"
          aria-label="Filter decision mode"
        >
          {["all", "shadow", "promoted"].map((value) => (
            <button
              key={value}
              className={mode === value ? "selected" : ""}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {value === "all" ? "All decisions" : `${readable(value)} mode`}
            </button>
          ))}
        </div>
        <label className="category-filter">
          <span className="sr-only">Decision category</span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="all">All categories</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {readable(value)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {decisions.loading && !decisions.data ? (
        <Loading label="Loading decision evidence…" />
      ) : filtered.length ? (
        <div className="panel decision-table">
          <div className="decision-table-header">
            <span>Decision / category</span>
            <span>Selection</span>
            <span>Confidence</span>
            <span>Mode</span>
          </div>
          {filtered.map((record) => (
            <details className="decision-row" key={record.id}>
              <summary>
                <div>
                  <strong>{readable(record.category)}</strong>
                  <span className="small muted">
                    {date(record.createdAt)} · {record.provider}
                  </span>
                </div>
                <span className="decision-selection">
                  {record.selected ?? "Abstained"}
                </span>
                <span className="confidence">
                  {record.confidence === null
                    ? "Not reported"
                    : `${Math.round(record.confidence * 100)}%`}
                </span>
                <Status value={record.mode} />
              </summary>
              <div className="decision-evidence">
                <div className="decision-metadata">
                  <div>
                    <span>Baseline</span>
                    <strong>{record.baseline}</strong>
                  </div>
                  <div>
                    <span>Model version</span>
                    <strong>{record.modelVersion}</strong>
                  </div>
                  <div>
                    <span>Policy version</span>
                    <strong>{record.policyVersion}</strong>
                  </div>
                </div>
                <div className="candidate-list">
                  <span className="small muted">Candidates</span>
                  {record.candidates.map((candidate) => (
                    <Badge
                      key={candidate}
                      tone={candidate === record.selected ? "green" : "neutral"}
                    >
                      {candidate}
                    </Badge>
                  ))}
                </div>
                <h3>Recorded evidence</h3>
                <pre className="code-block">
                  {JSON.stringify(record.evidence, null, 2)}
                </pre>
              </div>
            </details>
          ))}
        </div>
      ) : (
        <div className="panel">
          <EmptyState icon="decision" title="Decisions will leave a trail">
            As the engine evaluates tasks, its choices and supporting evidence
            will appear here. Use this record to evaluate a category before
            promoting it.
          </EmptyState>
        </div>
      )}
    </>
  );
}
