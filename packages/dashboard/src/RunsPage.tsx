import { useEffect, useState, type FormEvent } from "react";
import type {
  ExecutionPlan,
  RunEvent,
  RunRecord,
} from "@graph-engineering/contracts";
import type { Api } from "./api";
import {
  dockerAvailable,
  type ProjectResponse,
  type TemplateSummary,
} from "./types";
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
import {
  activeRun,
  date,
  getError,
  number,
  readable,
  shortId,
} from "./view-model";
import { WorkerCapabilities } from "./WorkerCapabilities";

function RunTimeline({ events }: { events: RunEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.id}>
          <span
            className={`timeline-point ${/fail|error|denied/.test(event.type) ? "error" : ""}`}
          />
          <div className="timeline-header">
            <strong>{readable(event.type)}</strong>
            <time>{date(event.at)}</time>
          </div>
          {event.stepId && <p className="small muted">Step {event.stepId}</p>}
          {Object.keys(event.data).length > 0 && (
            <details className="event-details">
              <summary>Event details</summary>
              <pre className="code-block">
                {JSON.stringify(event.data, null, 2)}
              </pre>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}

export function RunsPage({
  api,
  project,
  active,
}: {
  api: Api;
  project: ProjectResponse;
  active: boolean;
}) {
  const runs = useResource<RunRecord[]>(api, active ? "/api/runs" : null);
  const templates = useResource<TemplateSummary[]>(
    api,
    active ? "/api/templates" : null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useResource<{ run: RunRecord; events: RunEvent[] }>(
    api,
    active && selectedId ? `/api/runs/${encodeURIComponent(selectedId)}` : null,
  );
  const [creating, setCreating] = useState(false);
  const [objective, setObjective] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [providerId, setProviderId] = useState("");
  const [effort, setEffort] = useState("");
  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconciled, setReconciled] = useState(false);
  const selectedProvider = project.capabilities.providers.find(
    (provider) => provider.id === providerId,
  );
  const orderedRuns =
    runs.data?.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) ??
    [];
  const run = detail.data?.run.id === selectedId ? detail.data.run : undefined;

  useEffect(() => {
    setReconciled(false);
  }, [selectedId, run?.status]);

  useEffect(() => {
    if (
      !active ||
      (!runs.data?.some((item) => activeRun(item.status)) &&
        !activeRun(run?.status ?? ""))
    )
      return;
    const interval = setInterval(() => {
      runs.reload();
      if (selectedId) detail.reload();
    }, 2500);
    return () => clearInterval(interval);
  }, [active, runs.data, run?.status, selectedId, runs.reload, detail.reload]);

  async function createPlan(event: FormEvent) {
    event.preventDefault();
    const criteria = acceptance
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!objective.trim() || !criteria.length) {
      setError("Add an objective and at least one acceptance criterion.");
      return;
    }
    setBusy("plan");
    setError(null);
    try {
      setPlan(
        await api<ExecutionPlan>("/api/plans", {
          objective: objective.trim(),
          acceptance: criteria,
          ...(providerId ? { providerId } : {}),
          ...(effort ? { effort } : {}),
        }),
      );
    } catch (cause) {
      setError(getError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    if (!plan) return;
    setBusy("start");
    setError(null);
    try {
      const result = await api<RunRecord>("/api/runs", { planId: plan.id });
      setSelectedId(result.id);
      setCreating(false);
      setPlan(null);
      runs.reload();
      detail.reload();
    } catch (cause) {
      setError(getError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function changeRun(action: "cancel" | "resume") {
    if (!selectedId || (action === "resume" && !reconciled)) return;
    setBusy(action);
    setError(null);
    try {
      await api<RunRecord>(
        `/api/runs/${encodeURIComponent(selectedId)}/${action}`,
        action === "resume" ? { reconciled: true } : {},
      );
      setReconciled(false);
      runs.reload();
      detail.reload();
    } catch (cause) {
      setError(getError(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="MANAGED EXECUTION"
        title="From intent to execution."
        action={
          <Button
            onClick={() => {
              setCreating((value) => !value);
              setError(null);
            }}
            variant={creating ? "secondary" : "primary"}
          >
            <Icon name={creating ? "close" : "plus"} size={17} />
            {creating ? "Close planner" : "New run"}
          </Button>
        }
      >
        Set an objective, review the plan, and follow the work from first step
        to verification.
      </PageHeading>
      <ErrorNotice
        message={error ?? runs.error}
        retry={runs.error ? runs.reload : undefined}
      />
      {!dockerAvailable(project) && (
        <div className="notice notice-subtle">
          <Icon name="shield" size={18} />
          <span>
            Isolated execution is unavailable. Start your Docker-compatible
            engine before starting or resuming a run.
          </span>
        </div>
      )}
      <WorkerCapabilities workers={project.capabilities.installedWorkers} />
      {creating && (
        <div className="run-planner">
          <form className="panel" onSubmit={createPlan}>
            <div className="panel-heading">
              <div>
                <div className="eyebrow">01 / DEFINE</div>
                <h2>What should change?</h2>
              </div>
            </div>
            <div className="form-field">
              <label htmlFor="run-objective">Objective</label>
              <textarea
                id="run-objective"
                rows={3}
                required
                value={objective}
                onChange={(event) => {
                  setObjective(event.target.value);
                  setPlan(null);
                }}
                placeholder="Describe the engineering work you want to complete…"
              />
            </div>
            <div className="form-field">
              <label htmlFor="run-acceptance">
                Acceptance criteria <span className="muted">One per line</span>
              </label>
              <textarea
                id="run-acceptance"
                rows={3}
                required
                value={acceptance}
                onChange={(event) => {
                  setAcceptance(event.target.value);
                  setPlan(null);
                }}
                placeholder="What must be true when the work is done?"
              />
            </div>
            <div className="form-row">
              <div className="form-field">
                <label htmlFor="run-provider">Worker</label>
                <select
                  id="run-provider"
                  value={providerId}
                  onChange={(event) => {
                    setProviderId(event.target.value);
                    setEffort("");
                    setPlan(null);
                  }}
                >
                  <option value="">Choose by project policy</option>
                  {project.capabilities.providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.id} · {provider.model}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="run-effort">Reasoning effort</label>
                <select
                  id="run-effort"
                  value={effort}
                  disabled={!selectedProvider?.efforts?.length}
                  onChange={(event) => {
                    setEffort(event.target.value);
                    setPlan(null);
                  }}
                >
                  <option value="">Provider default</option>
                  {selectedProvider?.efforts?.map((value) => (
                    <option key={value} value={value}>
                      {readable(value)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-actions">
              <span className="small muted">
                Planning does not start a worker.
              </span>
              <Button
                type="submit"
                busy={busy === "plan"}
                disabled={busy !== null}
              >
                Create plan <Icon name="arrow" size={16} />
              </Button>
            </div>
          </form>
          <div className="panel plan-preview">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">02 / REVIEW</div>
                <h2>Execution plan</h2>
              </div>
              {plan && <Badge>{plan.steps.length} steps</Badge>}
            </div>
            {plan ? (
              <>
                <p className="plan-objective">{plan.objective}</p>
                <ol className="plan-steps">
                  {plan.steps.map((step, index) => (
                    <li key={step.id}>
                      <span className="step-number">{index + 1}</span>
                      <div>
                        <strong>{step.objective}</strong>
                        <p>
                          {step.kind === "template"
                            ? step.templateId
                            : (step.providerId ?? "Policy-selected worker")}
                          {step.effort ? ` · ${step.effort} effort` : ""}
                        </p>
                        {step.dependsOn.length > 0 && (
                          <span className="small muted">
                            After {step.dependsOn.join(", ")}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
                <div className="plan-verification">
                  <strong>Required verification</strong>
                  {plan.verification.length ? (
                    plan.verification.map((verification, index) => (
                      <code key={index}>{verification.argv.join(" ")}</code>
                    ))
                  ) : (
                    <p>
                      No verification commands are configured for this project.
                    </p>
                  )}
                </div>
                <dl className="property-list compact">
                  <div>
                    <dt>Snapshot</dt>
                    <dd className="mono">{shortId(plan.snapshotId)}</dd>
                  </div>
                  <div>
                    <dt>Publication</dt>
                    <dd>
                      {plan.publication === "none"
                        ? "Local work only"
                        : readable(plan.publication)}
                    </dd>
                  </div>
                </dl>
                <Button
                  className="full-width"
                  busy={busy === "start"}
                  disabled={!dockerAvailable(project) || busy !== null}
                  onClick={start}
                >
                  <Icon name="run" size={17} />
                  Start isolated run
                </Button>
              </>
            ) : (
              <EmptyState icon="run" title="A plan before the work">
                Define the task to see the selected steps, worker, and
                verification commands.
              </EmptyState>
            )}
          </div>
        </div>
      )}
      <div className="runs-layout">
        <div>
          <div className="panel run-list">
            <div className="panel-heading">
              <h2>Run history</h2>
              <button
                className="icon-button"
                onClick={runs.reload}
                aria-label="Refresh runs"
              >
                <Icon name="refresh" size={16} />
              </button>
            </div>
            {runs.loading && !runs.data ? (
              <Loading label="Loading runs…" />
            ) : orderedRuns.length ? (
              orderedRuns.map((record) => (
                <button
                  className={`run-option ${record.id === selectedId && !creating ? "selected" : ""}`}
                  key={record.id}
                  onClick={() => {
                    setSelectedId(record.id);
                    setCreating(false);
                  }}
                >
                  <div>
                    <strong>{record.plan.objective}</strong>
                    <Status value={record.status} />
                  </div>
                  <span className="small muted">
                    {date(record.createdAt)} · {shortId(record.id)}
                  </span>
                </button>
              ))
            ) : (
              <EmptyState icon="run" title="No runs yet">
                Create a plan to begin your first managed task.
              </EmptyState>
            )}
          </div>
          <div className="panel template-panel">
            <div className="panel-heading">
              <h2>Workflow library</h2>
              <Badge>{templates.data?.length ?? "—"}</Badge>
            </div>
            <ErrorNotice message={templates.error} retry={templates.reload} />
            {templates.loading ? (
              <Loading label="Loading templates…" />
            ) : templates.data?.length ? (
              <details className="template-details">
                <summary>
                  {templates.data.length} registered template
                  {templates.data.length === 1 ? "" : "s"}
                </summary>
                <div className="template-list">
                  {templates.data.map((template) => (
                    <div key={template.id}>
                      <div>
                        <strong>{template.name}</strong>
                        <span className="small muted break-word">
                          {template.source}
                        </span>
                      </div>
                      <Status value={template.status} />
                    </div>
                  ))}
                </div>
              </details>
            ) : (
              <p className="inline-hint">
                No workflow templates are registered.
              </p>
            )}
          </div>
        </div>
        <div className="panel run-detail">
          <ErrorNotice message={detail.error} retry={detail.reload} />
          {detail.loading && !run ? (
            <Loading label="Loading run details…" />
          ) : run ? (
            <>
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">RUN {shortId(run.id)}</div>
                  <h2>{run.plan.objective}</h2>
                  <p>{date(run.createdAt)}</p>
                </div>
                <Status value={run.status} />
              </div>
              {run.error && <ErrorNotice message={run.error} />}
              <div className="run-detail-toolbar">
                <span className="small muted">
                  {run.branch ? `Branch ${run.branch}` : "No branch recorded"}
                </span>
                {activeRun(run.status) && (
                  <Button
                    variant="danger"
                    busy={busy === "cancel"}
                    disabled={busy !== null}
                    onClick={() => changeRun("cancel")}
                  >
                    Cancel run
                  </Button>
                )}
              </div>
              {["failed", "cancelled", "needs_reconciliation"].includes(
                run.status,
              ) && (
                <div className="reconciliation-panel">
                  <strong>Review before resuming</strong>
                  <p>
                    Inspect the retained workspace and any external effects.
                    Resuming may repeat unfinished operations.
                  </p>
                  {run.workspace && (
                    <code className="break-word">{run.workspace}</code>
                  )}
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={reconciled}
                      onChange={(event) => setReconciled(event.target.checked)}
                    />
                    I have inspected the workspace and reconciled any external
                    effects.
                  </label>
                  <Button
                    variant="secondary"
                    busy={busy === "resume"}
                    disabled={
                      !reconciled || busy !== null || !dockerAvailable(project)
                    }
                    onClick={() => changeRun("resume")}
                  >
                    Resume run <Icon name="arrow" size={15} />
                  </Button>
                </div>
              )}
              <div className="run-usage">
                <div>
                  <span>Input tokens</span>
                  <strong>
                    {run.usage.inputTokens === null
                      ? "Not reported"
                      : number(run.usage.inputTokens)}
                  </strong>
                </div>
                <div>
                  <span>Output tokens</span>
                  <strong>
                    {run.usage.outputTokens === null
                      ? "Not reported"
                      : number(run.usage.outputTokens)}
                  </strong>
                </div>
                <div>
                  <span>
                    {run.usage.estimated ? "Estimated cost" : "Reported cost"}
                  </span>
                  <strong>
                    {run.usage.costUsd === null
                      ? "Not reported"
                      : `$${run.usage.costUsd.toFixed(4)}`}
                  </strong>
                </div>
              </div>
              <details className="subtle-details run-acceptance">
                <summary>Acceptance criteria</summary>
                <ul>
                  {run.plan.acceptance.map((criterion, index) => (
                    <li key={index}>{criterion}</li>
                  ))}
                </ul>
              </details>
              {run.commit && (
                <div className="notice notice-success">
                  Commit recorded: <code>{shortId(run.commit)}</code>
                </div>
              )}
              {run.pullRequest && (
                <div className="notice notice-success">
                  Pull request:{" "}
                  <a
                    href={
                      /^https:\/\/github\.com\//.test(run.pullRequest)
                        ? run.pullRequest
                        : undefined
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    {run.pullRequest}
                  </a>
                </div>
              )}
              <div className="timeline-title">
                <h3>Activity</h3>
                {activeRun(run.status) && (
                  <span className="live-label">
                    <span className="status-dot" />
                    Live
                  </span>
                )}
              </div>
              {detail.data?.events.length ? (
                <RunTimeline events={detail.data.events} />
              ) : (
                <p className="inline-hint">
                  No events have been recorded for this run.
                </p>
              )}
            </>
          ) : (
            <EmptyState icon="clock" title="The work, with a paper trail">
              Choose a run to see its plan, status, usage, and recorded events.
            </EmptyState>
          )}
        </div>
      </div>
    </>
  );
}
