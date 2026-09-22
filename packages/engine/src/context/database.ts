import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

export interface Statement {
  sql: string;
  params?: unknown[];
}

// SQLite's synchronous native API belongs to this dedicated thread. Statements
// are data, never executable worker source. One worker serializes each engine.
export class ContextDatabase {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private closed = false;
  constructor(path: string) {
    const require = createRequire(import.meta.url);
    this.worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require(workerData.databaseModule);
      const db = new Database(workerData.path);
      db.pragma('busy_timeout = 5000');
      // Two client processes can initialize the same project simultaneously.
      // Changing journal mode may report BUSY without honoring busy_timeout.
      for (let attempt = 0; ; attempt++) {
        try { db.pragma('journal_mode = WAL'); break; }
        catch (error) {
          if (error.code !== 'SQLITE_BUSY' || attempt >= 6) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(50 * 2 ** attempt, 500));
        }
      }
      db.pragma('foreign_keys = ON');
      let vectorError = null;
      try { require(workerData.vectorModule).load(db); } catch (error) { vectorError = error.message; }
      parentPort.on('message', ({ id, operation, sql, params, statements, snapshotId }) => {
        try {
          let value;
          if (operation === 'exec') value = db.exec(sql) && null;
          else if (operation === 'batch') value = db.transaction(() => statements.map(s => db.prepare(s.sql).run(...(s.params || []))))();
          else if (operation === 'snapshotBatch') value = db.transaction(() => {
            if (db.prepare('SELECT id FROM snapshots WHERE id=?').get(snapshotId)) return false;
            for (const statement of statements) db.prepare(statement.sql).run(...(statement.params || []));
            return true;
          }).immediate();
          else if (operation === 'vectorStatus') value = vectorError;
          else if (operation === 'close') { db.close(); value = null; }
          else value = db.prepare(sql)[operation](...(params || []));
          parentPort.postMessage({ id, value });
          if (operation === 'close') parentPort.close();
        } catch (error) { parentPort.postMessage({ id, error: error.message }); }
      });
    `,
      {
        eval: true,
        workerData: {
          path,
          databaseModule: require.resolve("better-sqlite3"),
          vectorModule: require.resolve("sqlite-vec"),
        },
      },
    );
    this.worker.on("message", ({ id, value, error }) => {
      const operation = this.pending.get(id);
      this.pending.delete(id);
      if (error) operation?.reject(new Error(error));
      else operation?.resolve(value);
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.closed)
        this.fail(new Error(`Context database worker exited (${code})`));
    });
  }
  private fail(error: Error) {
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    this.closed = true;
  }
  private request(operation: string, payload: object = {}): Promise<any> {
    if (this.closed)
      return Promise.reject(new Error("Context database is closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, operation, ...payload });
    });
  }
  exec(sql: string): Promise<void> {
    return this.request("exec", { sql });
  }
  run(sql: string, params: unknown[] = []): Promise<void> {
    return this.request("run", { sql, params });
  }
  get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.request("get", { sql, params });
  }
  all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.request("all", { sql, params });
  }
  batch(statements: Statement[]): Promise<void> {
    return this.request("batch", { statements });
  }
  snapshotBatch(snapshotId: string, statements: Statement[]): Promise<boolean> {
    return this.request("snapshotBatch", { snapshotId, statements });
  }
  vectorStatus(): Promise<string | null> {
    return this.request("vectorStatus");
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await this.request("close");
    this.closed = true;
    await this.worker.terminate();
  }
}

export const CONTEXT_SCHEMA = `
CREATE TABLE IF NOT EXISTS context_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (snapshot_id TEXT NOT NULL REFERENCES snapshots(id), path TEXT NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(snapshot_id,path));
CREATE TABLE IF NOT EXISTS symbols (snapshot_id TEXT NOT NULL REFERENCES snapshots(id), id TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(snapshot_id,id));
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(snapshot_id,name);
CREATE TABLE IF NOT EXISTS edges (snapshot_id TEXT NOT NULL REFERENCES snapshots(id), id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT, payload TEXT NOT NULL, PRIMARY KEY(snapshot_id,id));
CREATE INDEX IF NOT EXISTS edges_source ON edges(snapshot_id,source_id);
CREATE INDEX IF NOT EXISTS edges_target ON edges(snapshot_id,target_id);
CREATE TABLE IF NOT EXISTS chunks (id TEXT NOT NULL, snapshot_id TEXT NOT NULL REFERENCES snapshots(id), path TEXT NOT NULL, content_hash TEXT NOT NULL, text TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(snapshot_id,id));
CREATE INDEX IF NOT EXISTS chunks_path ON chunks(snapshot_id,path);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED,snapshot_id UNINDEXED,path,text,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS embeddings (cache_key TEXT PRIMARY KEY, model TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS chunk_embeddings (snapshot_id TEXT NOT NULL, chunk_id TEXT NOT NULL, cache_key TEXT NOT NULL REFERENCES embeddings(cache_key), PRIMARY KEY(snapshot_id,chunk_id));
CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
`;
