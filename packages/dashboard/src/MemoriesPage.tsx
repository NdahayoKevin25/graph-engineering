import { useState, type FormEvent } from "react";
import type { MemoryKind, MemoryRecord } from "@graph-engineering/contracts";
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
import { date, getError, readable } from "./view-model";

export function MemoriesPage({ api, active }: { api: Api; active: boolean }) {
  const memories = useResource<MemoryRecord[]>(
    api,
    active ? "/api/memories" : null,
  );
  const [text, setText] = useState("");
  const [kind, setKind] = useState<MemoryKind>("observation");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const records =
    memories.data?.filter(
      (record) =>
        filter === "all" ||
        (filter === "shared"
          ? record.visibility === "shared"
          : record.status === filter),
    ) ?? [];

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy("new");
    setError(null);
    setNotice(null);
    try {
      await api<MemoryRecord>("/api/memories", { text: text.trim(), kind });
      setText("");
      setAdding(false);
      memories.reload();
    } catch (cause) {
      setError(getError(cause));
    } finally {
      setBusy(null);
    }
  }
  async function change(record: MemoryRecord, action: "accept" | "promote") {
    setBusy(record.id);
    setError(null);
    setNotice(null);
    try {
      if (action === "promote") {
        const result = await api<{ path: string; record: MemoryRecord }>(
          `/api/memories/${encodeURIComponent(record.id)}/promote`,
          {},
        );
        setNotice(
          `Shared knowledge written to ${result.path}. Review it alongside your project changes.`,
        );
      } else {
        await api<MemoryRecord>(
          `/api/memories/${encodeURIComponent(record.id)}/accept`,
          {},
        );
      }
      memories.reload();
    } catch (cause) {
      setError(getError(cause));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="PROJECT MEMORY"
        title="Keep what matters."
        action={
          <Button
            onClick={() => setAdding((value) => !value)}
            variant={adding ? "secondary" : "primary"}
          >
            <Icon name={adding ? "close" : "plus"} size={17} />
            {adding ? "Close editor" : "Add memory"}
          </Button>
        }
      >
        Capture the reasons, constraints, and discoveries your next session
        should remember.
      </PageHeading>
      <ErrorNotice
        message={error ?? memories.error}
        retry={memories.error ? memories.reload : undefined}
      />
      {notice && (
        <div className="notice notice-success" role="status">
          <Icon name="check" size={18} />
          <span>{notice}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {adding && (
        <form className="panel memory-form" onSubmit={save}>
          <div className="panel-heading">
            <div>
              <h2>A note for future you</h2>
              <p>
                New memories start as proposals. Review them before they inform
                future work.
              </p>
            </div>
          </div>
          <div className="form-field">
            <label htmlFor="memory-kind">Kind</label>
            <select
              id="memory-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as MemoryKind)}
            >
              {(
                [
                  "observation",
                  "decision",
                  "requirement",
                  "constraint",
                  "solution",
                ] as const
              ).map((value) => (
                <option key={value} value={value}>
                  {readable(value)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="memory-text">
              What should this project remember?
            </label>
            <textarea
              id="memory-text"
              rows={4}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Describe the fact or decision, and why it matters…"
              required
            />
          </div>
          <div className="form-actions">
            <span className="small muted">Saved privately on this machine</span>
            <Button type="submit" busy={busy === "new"} disabled={!text.trim()}>
              Save proposal <Icon name="arrow" size={16} />
            </Button>
          </div>
        </form>
      )}
      <div className="section-toolbar">
        <div className="filter-tabs" role="group" aria-label="Filter memories">
          {["all", "proposed", "accepted", "shared"].map((value) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={filter === value ? "selected" : ""}
            >
              {value === "all" ? "All memories" : readable(value)}
              {value === "proposed" &&
                Boolean(
                  memories.data?.filter(
                    (record) => record.status === "proposed",
                  ).length,
                ) && (
                  <span>
                    {
                      memories.data!.filter(
                        (record) => record.status === "proposed",
                      ).length
                    }
                  </span>
                )}
            </button>
          ))}
        </div>
        <span className="small muted">
          {records.length} record{records.length === 1 ? "" : "s"}
        </span>
      </div>
      {memories.loading ? (
        <Loading label="Loading project memory…" />
      ) : records.length ? (
        <div className="memory-grid">
          {records
            .slice()
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((record) => (
              <article className="panel memory-card" key={record.id}>
                <div className="memory-card-top">
                  <span className="memory-kind">
                    <Icon
                      name={
                        record.kind === "decision"
                          ? "decision"
                          : record.kind === "constraint"
                            ? "shield"
                            : "memory"
                      }
                      size={16}
                    />
                    {record.kind}
                  </span>
                  <Status value={record.status} />
                </div>
                <p className="memory-text">{record.text}</p>
                {record.sources.length > 0 && (
                  <details className="memory-sources">
                    <summary>
                      {record.sources.length} source reference
                      {record.sources.length === 1 ? "" : "s"}
                    </summary>
                    {record.sources.map((source, index) => (
                      <p className="mono small break-word" key={index}>
                        {source.path}:{source.startLine}–{source.endLine}
                      </p>
                    ))}
                  </details>
                )}
                <div className="memory-card-bottom">
                  <div>
                    <span className="small muted">
                      {date(record.createdAt)}
                    </span>
                    <Badge
                      tone={
                        record.visibility === "shared" ? "green" : "neutral"
                      }
                    >
                      {record.visibility}
                    </Badge>
                  </div>
                  {record.status === "proposed" && (
                    <Button
                      variant="secondary"
                      busy={busy === record.id}
                      disabled={busy !== null}
                      onClick={() => change(record, "accept")}
                    >
                      <Icon name="check" size={16} />
                      Accept
                    </Button>
                  )}
                  {record.status === "accepted" &&
                    record.visibility === "private" && (
                      <Button
                        variant="secondary"
                        busy={busy === record.id}
                        disabled={busy !== null}
                        onClick={() => change(record, "promote")}
                      >
                        Share to repository <Icon name="arrow" size={15} />
                      </Button>
                    )}
                </div>
              </article>
            ))}
        </div>
      ) : (
        <div className="panel">
          <EmptyState
            icon="memory"
            title={
              filter === "all"
                ? "Your project memory starts here"
                : `No ${filter} memories`
            }
          >
            Save a useful observation or decision. Accepted memories can be
            shared with your partner through the repository.
          </EmptyState>
        </div>
      )}
    </>
  );
}
