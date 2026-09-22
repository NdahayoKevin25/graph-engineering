import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  DecisionRecord,
  ExecutionPlan,
  RunEvent,
  RunRecord,
} from "@graph-engineering/contracts";
import { id, now } from "./util.js";
import { redact } from "./policy.js";

/** Small operational records only. Context DB/index work lives in the context worker. */
export class RunStore {
  private db: Database.Database;
  constructor(
    dataDir: string,
    private projectId: string,
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(dataDir, "runs.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,run_id TEXT,project_id TEXT,json TEXT);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON run_events(project_id,run_id,seq);
      CREATE TABLE IF NOT EXISTS run_owners(run_id TEXT PRIMARY KEY,pid INTEGER NOT NULL); PRAGMA user_version = 1;`);
  }
  savePlan(plan: ExecutionPlan): void {
    this.db
      .prepare("INSERT INTO plans VALUES(?,?,?)")
      .run(plan.id, this.projectId, JSON.stringify(plan));
  }
  plan(id: string): ExecutionPlan {
    return this.one("plans", id);
  }
  saveRun(run: RunRecord): void {
    this.db
      .prepare("INSERT OR REPLACE INTO runs VALUES(?,?,?)")
      .run(run.id, this.projectId, JSON.stringify(run));
  }
  reserve(run: RunRecord, limit: number): void {
    this.db
      .transaction(() => {
        const active = this.runs().filter((r) =>
          ["planned", "running", "verifying"].includes(r.status),
        );
        if (active.length >= limit)
          throw new Error("Project concurrency limit reached");
        this.saveRun(run);
        this.db
          .prepare("INSERT OR REPLACE INTO run_owners VALUES(?,?)")
          .run(run.id, process.pid);
      })
      .immediate();
  }
  reserveResume(runId: string, limit: number): RunRecord {
    return this.db
      .transaction(() => {
        const run = this.run(runId);
        if (
          !["failed", "cancelled", "needs_reconciliation"].includes(run.status)
        )
          throw new Error("Run does not need resumption");
        if (
          this.runs().filter((r) =>
            ["planned", "running", "verifying"].includes(r.status),
          ).length >= limit
        )
          throw new Error("Project concurrency limit reached");
        const resumed = {
          ...run,
          status: "planned" as const,
          updatedAt: now(),
        };
        this.saveRun(resumed);
        this.db
          .prepare("INSERT OR REPLACE INTO run_owners VALUES(?,?)")
          .run(run.id, process.pid);
        return resumed;
      })
      .immediate();
  }
  claim(runId: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO run_owners VALUES(?,?)")
      .run(runId, process.pid);
  }
  run(id: string): RunRecord {
    return this.one("runs", id);
  }
  runs(): RunRecord[] {
    return this.all("runs").reverse() as RunRecord[];
  }
  events(runId: string): RunEvent[] {
    return this.db
      .prepare(
        "SELECT json FROM run_events WHERE project_id=? AND run_id=? ORDER BY seq",
      )
      .all(this.projectId, runId)
      .map((r) => JSON.parse((r as { json: string }).json));
  }
  event(
    runId: string,
    type: string,
    data: Record<string, unknown>,
    stepId?: string,
  ): RunEvent {
    const clean = (value: unknown): unknown =>
      typeof value === "string"
        ? redact(value)
        : Array.isArray(value)
          ? value.map(clean)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([k, v]) => [
                  k,
                  /api.?key|password|credential|secret|token/i.test(k) &&
                  !["inputTokens", "outputTokens", "cachedTokens"].includes(k)
                    ? "[REDACTED]"
                    : clean(v),
                ]),
              )
            : value;
    const safeData = clean(data) as Record<string, unknown>;
    const event: RunEvent = {
      version: "1.0.0",
      id: id(),
      runId,
      projectId: this.projectId,
      at: now(),
      type,
      stepId,
      data: safeData,
    };
    this.db
      .prepare(
        "INSERT INTO run_events(id,run_id,project_id,json) VALUES(?,?,?,?)",
      )
      .run(event.id, runId, this.projectId, JSON.stringify(event));
    return event;
  }
  decision(record: DecisionRecord): void {
    this.db
      .prepare("INSERT INTO decisions VALUES(?,?,?)")
      .run(record.id, this.projectId, JSON.stringify(record));
  }
  decisions(): DecisionRecord[] {
    return this.all("decisions").reverse() as DecisionRecord[];
  }
  recoverInterrupted(): void {
    for (const run of this.runs())
      if (["planned", "running", "verifying"].includes(run.status)) {
        const owner = this.db
          .prepare("SELECT pid FROM run_owners WHERE run_id=?")
          .get(run.id) as { pid: number } | undefined;
        if (owner) {
          try {
            process.kill(owner.pid, 0);
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
          }
        }
        this.saveRun({
          ...run,
          status: "needs_reconciliation",
          updatedAt: now(),
          error:
            "The previous process stopped during execution. Inspect its workspace and events before retrying.",
        });
        this.event(run.id, "recovery.required", {});
      }
  }
  private one<T>(table: string, id: string): T {
    const row = this.db
      .prepare(`SELECT json FROM ${table} WHERE id=? AND project_id=?`)
      .get(id, this.projectId) as { json: string } | undefined;
    if (!row) throw new Error(`${table}: record not found`);
    return JSON.parse(row.json) as T;
  }
  private all(table: string): unknown[] {
    return this.db
      .prepare(`SELECT json FROM ${table} WHERE project_id=? ORDER BY rowid`)
      .all(this.projectId)
      .map((r) => JSON.parse((r as { json: string }).json));
  }
  close(): void {
    this.db.close();
  }
}
