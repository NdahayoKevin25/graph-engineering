import { useState, type FormEvent } from "react";
import type {
  ContextPacket,
  RepositorySnapshot,
} from "@graph-engineering/contracts";
import type { Api } from "./api";
import type { ProjectResponse } from "./types";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Icon,
  Loading,
  PageHeading,
  useResource,
} from "./components";
import { date, getError, number, shortId } from "./view-model";

export function ContextPage({
  api,
  project,
  indexed,
}: {
  api: Api;
  project: ProjectResponse;
  indexed: () => void;
}) {
  const snapshots = useResource<RepositorySnapshot[]>(api, "/api/snapshots");
  const latest = snapshots.data
    ?.slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const [query, setQuery] = useState("");
  const [budget, setBudget] = useState(
    Math.min(8000, project.config.policy.maxContextTokens),
  );
  const [packet, setPacket] = useState<ContextPacket | null>(null);
  const [busy, setBusy] = useState<"index" | "search" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function index() {
    setBusy("index");
    setError(null);
    try {
      await api<RepositorySnapshot>("/api/index", {});
      setPacket(null);
      snapshots.reload();
      indexed();
    } catch (cause) {
      setError(getError(cause));
    } finally {
      setBusy(null);
    }
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy("search");
    setError(null);
    setCopied(false);
    try {
      setPacket(
        await api<ContextPacket>("/api/context", {
          query: query.trim(),
          budgetTokens: budget,
        }),
      );
    } catch (cause) {
      setError(getError(cause));
    } finally {
      setBusy(null);
    }
  }
  async function copyPacket() {
    if (!packet) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(packet, null, 2));
      setCopied(true);
    } catch {
      setError(
        "Your browser could not copy the packet. Select the context below to copy it manually.",
      );
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="YOUR ENGINEERING WORKSPACE"
        title="Start with the right context."
        action={
          <Button
            variant="secondary"
            busy={busy === "index"}
            disabled={busy === "search"}
            onClick={index}
          >
            <Icon name="refresh" size={16} />
            {latest ? "Update index" : "Index project"}
          </Button>
        }
      >
        Find the code, knowledge, and connections that matter to your next move.
      </PageHeading>
      <ErrorNotice
        message={error ?? snapshots.error}
        retry={snapshots.error ? snapshots.reload : undefined}
      />
      <div className="metric-grid">
        <div className="metric">
          <span className="metric-label">
            Files indexed <Icon name="folder" size={16} />
          </span>
          <strong>{latest ? number(latest.fileCount) : "—"}</strong>
          <span className="metric-foot">
            {latest
              ? `${latest.languages.length} language${latest.languages.length === 1 ? "" : "s"} in this snapshot`
              : "Index this project to get started"}
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">
            Current snapshot <Icon name="graph" size={16} />
          </span>
          <strong className="metric-code">
            {latest ? shortId(latest.revision) : "—"}
          </strong>
          <span className="metric-foot">
            {latest ? date(latest.createdAt) : "No snapshot yet"}
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">
            Context allowance <Icon name="context" size={16} />
          </span>
          <strong>
            {number(project.config.policy.maxContextTokens)}
            <small> tokens</small>
          </strong>
          <span className="metric-foot">
            Maximum per project context packet
          </span>
        </div>
      </div>
      <div className="context-layout">
        <div className="context-main">
          <div className="panel search-panel">
            <div className="panel-heading">
              <div>
                <h2>What are you working on?</h2>
                <p>Describe a task, ask a question, or look up a symbol.</p>
              </div>
              <span className="panel-index">01 / RETRIEVE</span>
            </div>
            <form onSubmit={search}>
              <label className="sr-only" htmlFor="context-query">
                Context search
              </label>
              <div className="query-input">
                <Icon name="search" size={21} />
                <textarea
                  id="context-query"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Where is authentication handled, and what decisions shaped it?"
                  rows={3}
                  required
                />
              </div>
              <div className="search-toolbar">
                <label className="budget-label" htmlFor="context-budget">
                  Token budget{" "}
                  <input
                    id="context-budget"
                    type="number"
                    min={256}
                    max={project.config.policy.maxContextTokens}
                    step={1}
                    value={budget}
                    onChange={(event) => setBudget(Number(event.target.value))}
                    required
                  />
                </label>
                <Button
                  type="submit"
                  busy={busy === "search"}
                  disabled={!latest || busy === "index" || !query.trim()}
                >
                  Build context <Icon name="arrow" size={16} />
                </Button>
              </div>
            </form>
            {!latest && !snapshots.loading && (
              <p className="inline-hint">
                Create your first index to search this workspace.
              </p>
            )}
          </div>
          {busy === "search" ? (
            <div className="panel">
              <Loading label="Finding relevant context…" />
            </div>
          ) : packet ? (
            <div className="panel results-panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">CONTEXT PACKET</div>
                  <h2>
                    {packet.items.length} relevant item
                    {packet.items.length === 1 ? "" : "s"}
                  </h2>
                  <p>
                    {number(packet.estimatedTokens)} estimated tokens ·{" "}
                    {number(packet.budgetTokens)} budget
                  </p>
                </div>
                <Button variant="ghost" onClick={copyPacket}>
                  {copied ? (
                    <>
                      <Icon name="check" size={16} />
                      Copied
                    </>
                  ) : (
                    "Copy packet"
                  )}
                </Button>
              </div>
              <div className="packet-bar">
                <span
                  style={{
                    width: `${Math.min(100, (100 * packet.estimatedTokens) / Math.max(1, packet.budgetTokens))}%`,
                  }}
                />
              </div>
              <div className="packet-coverage">
                <Badge tone={packet.coverage.semantic ? "green" : "neutral"}>
                  {packet.coverage.semantic
                    ? "Semantic search available"
                    : "Lexical + graph retrieval"}
                </Badge>
                <span className="small muted">
                  Snapshot {shortId(packet.snapshotId)}
                </span>
              </div>
              {packet.coverage.warnings.map((warning, index) => (
                <div key={index} className="notice notice-subtle">
                  {warning}
                </div>
              ))}
              {packet.mandatory.length > 0 && (
                <details className="context-item">
                  <summary>
                    <span className="item-kind">POLICY</span>
                    <strong>Required project constraints</strong>
                    <span className="muted small">
                      {packet.mandatory.length}
                    </span>
                  </summary>
                  <div className="constraint-list">
                    {packet.mandatory.map((rule, index) => (
                      <p key={index}>{rule}</p>
                    ))}
                  </div>
                </details>
              )}
              {packet.items.map((item, index) => (
                <details
                  className="context-item"
                  key={item.id}
                  open={index === 0}
                >
                  <summary>
                    <span className="item-kind">{item.kind.toUpperCase()}</span>
                    <div>
                      <strong>
                        {item.source?.path ??
                          `${item.kind === "memory" ? "Memory" : "Document"} ${shortId(item.memoryId ?? item.id)}`}
                      </strong>
                      {item.source && (
                        <span className="small muted">
                          Lines {item.source.startLine}–{item.source.endLine}
                        </span>
                      )}
                    </div>
                    <span
                      className="relevance-score"
                      title="Retrieval ranking score, not a probability"
                    >
                      {item.score.toFixed(2)}
                    </span>
                  </summary>
                  <pre className="code-block">{item.text}</pre>
                </details>
              ))}
              {!packet.items.length && (
                <EmptyState icon="search" title="No matching context">
                  Try naming a file, module, or specific behavior. Updating the
                  index may surface recent changes.
                </EmptyState>
              )}
            </div>
          ) : (
            <div className="retrieval-explainer">
              <div className="mini-graph" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
                <i />
                <i />
                <i />
              </div>
              <h3>A small packet. A wider perspective.</h3>
              <p>
                Search across your source, follow its relationships, and bring
                in the decisions behind it.
              </p>
              <div className="retrieval-labels">
                <span>Source code</span>
                <span>Connections</span>
                <span>Project memory</span>
              </div>
            </div>
          )}
        </div>
        <aside className="context-aside">
          <div className="panel policy-panel">
            <span className="section-icon">
              <Icon name="shield" size={19} />
            </span>
            <h2>Project boundaries</h2>
            <p>The policy every managed run starts from.</p>
            <dl className="property-list">
              <div>
                <dt>Inference</dt>
                <dd>
                  {project.config.policy.inference === "local"
                    ? "Local only"
                    : "Provider allowlist"}
                </dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>
                  {project.config.policy.network === "deny"
                    ? "Denied"
                    : "Host allowlist"}
                </dd>
              </div>
              <div>
                <dt>Publication</dt>
                <dd>
                  {project.config.policy.publication === "none"
                    ? "Local work only"
                    : project.config.policy.publication === "draft-pr"
                      ? "Draft pull requests"
                      : "Commits"}
                </dd>
              </div>
              <div>
                <dt>Decision models</dt>
                <dd>
                  {project.config.policy.decisionMode === "shadow"
                    ? "Observe only"
                    : "Selected categories"}
                </dd>
              </div>
            </dl>
            <details className="subtle-details">
              <summary>View policy details</summary>
              <pre className="code-block">
                {JSON.stringify(project.config.policy, null, 2)}
              </pre>
            </details>
          </div>
          <div className="project-note">
            <div className="eyebrow">WORKING DIRECTORY</div>
            <p className="mono break-word">{project.root}</p>
            {latest && (
              <>
                <div className="eyebrow">INDEX COVERAGE</div>
                <p>
                  {number(latest.coverage.parsed)} parsed ·{" "}
                  {number(latest.coverage.textOnly)} text only
                </p>
                {latest.coverage.errors.length > 0 && (
                  <details>
                    <summary className="small">
                      {latest.coverage.errors.length} indexing issue
                      {latest.coverage.errors.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="small">
                      {latest.coverage.errors.map((message, index) => (
                        <li key={index}>{message}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
