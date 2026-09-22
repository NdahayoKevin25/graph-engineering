import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import ignore from "ignore";
import picomatch from "picomatch";
import {
  SCHEMA_VERSION,
  type CodeSymbol,
  type ContextItem,
  type ContextPacket,
  type GraphEdge,
  type MemoryKind,
  type MemoryRecord,
  type ProjectPolicy,
  type RepositorySnapshot,
  type SourceReference,
} from "@graph-engineering/contracts";
import { CONTEXT_SCHEMA, ContextDatabase, type Statement } from "./database.js";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_KEY,
  LocalEmbeddings,
} from "./embeddings.js";
import {
  chunkFile,
  hash,
  PARSER_VERSION,
  parseFile,
  type ParsedFile,
} from "./parser.js";
import { containsSecret } from "../policy.js";
export { containsSecret } from "../policy.js";

const execFileAsync = promisify(execFile);
const BUILTIN_EXCLUSIONS = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.graph/local/**",
  "**/.graph/workspaces/**",
  "**/.graph/cache/**",
  "**/.graph/knowledge/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.venv/**",
  "**/__pycache__/**",
];
// A byte upper bound avoids claiming compatibility with a particular tokenizer.
export const estimateTokens = (text: string): number =>
  Buffer.byteLength(text, "utf8");
// Preserve portable path identity while still allowing .graph/project.json as
// local context; worker isAllowedPath intentionally forbids all .graph writes.
const safePath = (path: string): boolean =>
  !!path &&
  !isAbsolute(path) &&
  !path.includes("\\") &&
  !/[<>:"|?*\x00-\x1f]/.test(path) &&
  !path
    .split("/")
    .some(
      (part) =>
        part === ".." ||
        part === "." ||
        part === "" ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    );
type Payload = { payload: string };
type Chunk = { id: string; text: string; source: SourceReference };
const json = <T>(row: Payload): T => JSON.parse(row.payload);

export class ContextEngine {
  private db!: ContextDatabase;
  private embeddings: LocalEmbeddings;
  private ready: Promise<void>;
  private indexing?: Promise<RepositorySnapshot>;
  private vectorError: string | null = null;
  readonly projectId: string;
  readonly root: string;
  readonly dataDir: string;
  readonly policy: ProjectPolicy;
  constructor(options: {
    projectId: string;
    root: string;
    dataDir: string;
    policy: ProjectPolicy;
  }) {
    this.projectId = options.projectId;
    this.root = resolve(options.root);
    this.dataDir = resolve(options.dataDir);
    this.policy = structuredClone(options.policy);
    this.embeddings = new LocalEmbeddings(this.dataDir);
    this.ready = this.initialize();
  }
  updatePolicy(policy: ProjectPolicy): void {
    Object.assign(this.policy, structuredClone(policy));
  }
  private async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    this.db = new ContextDatabase(join(this.dataDir, "context.sqlite"));
    try {
      await this.db.exec(CONTEXT_SCHEMA);
      await this.db.run(
        "INSERT OR IGNORE INTO context_metadata(key,value) VALUES(?,?)",
        ["projectId", this.projectId],
      );
      const existing = await this.db.get<{ value: string }>(
        "SELECT value FROM context_metadata WHERE key=?",
        ["projectId"],
      );
      if (existing?.value !== this.projectId)
        throw new Error("Context database belongs to a different project");
      this.vectorError = await this.db.vectorStatus();
      await chmod(join(this.dataDir, "context.sqlite"), 0o600);
    } catch (error) {
      await this.db.close();
      throw error;
    }
  }
  private excluded(path: string): boolean {
    return (
      !safePath(path) ||
      [...BUILTIN_EXCLUSIONS, ...this.policy.excludedPaths].some((pattern) =>
        picomatch(pattern, {
          dot: true,
          nocase: true,
          basename: !pattern.includes("/"),
        })(path),
      )
    );
  }
  private async git(args: string[]): Promise<string | null> {
    try {
      return (
        await execFileAsync(
          "git",
          ["-c", "core.fsmonitor=false", "-C", this.root, ...args],
          {
            maxBuffer: 32 * 1024 * 1024,
            timeout: 10000,
          },
        )
      ).stdout;
    } catch {
      return null;
    }
  }
  private async inventory(): Promise<string[]> {
    const listed = await this.git([
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    if (listed !== null)
      return [...new Set(listed.split("\0").filter(Boolean))]
        .filter((path) => !this.excluded(path))
        .sort();
    const result: string[] = [];
    const walk = async (
      directory: string,
      inherited: { base: string; matcher: ReturnType<typeof ignore> }[],
    ): Promise<void> => {
      const rules = [...inherited];
      try {
        rules.push({
          base: directory,
          matcher: ignore().add(
            await readFile(join(directory, ".gitignore"), "utf8"),
          ),
        });
      } catch {
        /* optional */
      }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name),
          path = relative(this.root, absolute).split(sep).join("/");
        let ignored = false;
        for (const rule of rules) {
          const result = rule.matcher.test(
            relative(rule.base, absolute).split(sep).join("/") +
              (entry.isDirectory() ? "/" : ""),
          );
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        }
        if (entry.isSymbolicLink() || this.excluded(path) || ignored) continue;
        if (entry.isDirectory()) await walk(absolute, rules);
        else if (entry.isFile()) result.push(path);
      }
    };
    await walk(this.root, [
      {
        base: this.root,
        matcher: ignore().add([
          ".git/",
          "node_modules/",
          ".graph/local/",
          ".graph/workspaces/",
          ".graph/cache/",
        ]),
      },
    ]);
    return result.sort();
  }
  async index(): Promise<RepositorySnapshot> {
    await this.ready;
    if (!this.indexing)
      this.indexing = this.buildIndex().finally(() => {
        this.indexing = undefined;
      });
    return this.indexing;
  }
  private async buildIndex(): Promise<RepositorySnapshot> {
    const [canonicalRoot, revision, branch, paths] = await Promise.all([
      realpath(this.root),
      this.git(["rev-parse", "HEAD"]),
      this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.inventory(),
    ]);
    const worktreeId = hash(canonicalRoot);
    const files: { path: string; text: string; hash: string }[] = [];
    const errors: string[] = [];
    for (const path of paths) {
      const absolute = join(this.root, path);
      try {
        const info = await lstat(absolute);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        const canonical = await realpath(absolute);
        if (
          !canonical.startsWith(canonicalRoot + sep) ||
          canonical.startsWith(this.dataDir + sep)
        )
          continue;
        if (info.size > 1024 * 1024) {
          errors.push(`${path}: skipped file larger than 1 MiB`);
          continue;
        }
        const bytes = await readFile(absolute);
        if (bytes.includes(0)) continue;
        const text = bytes.toString("utf8");
        if (containsSecret(text)) {
          errors.push(
            `${path}: omitted because a credential pattern was detected`,
          );
          continue;
        }
        files.push({ path, text, hash: hash(text) });
      } catch {
        errors.push(`${path}: file unavailable during indexing`);
      }
    }
    const contentHash = hash(
      JSON.stringify(files.map((file) => [file.path, file.hash])),
    );
    const id = hash(
      JSON.stringify({
        project: this.projectId,
        worktreeId,
        revision: revision?.trim(),
        branch: branch?.trim(),
        contentHash,
        parser: PARSER_VERSION,
        excluded: this.policy.excludedPaths,
      }),
    );
    const existing = await this.db.get<Payload>(
      "SELECT payload FROM snapshots WHERE id=? AND project_id=?",
      [id, this.projectId],
    );
    if (existing) {
      await this.db.run(
        "INSERT OR REPLACE INTO context_metadata(key,value) VALUES(?,?)",
        ["currentSnapshot", id],
      );
      await this.importSharedMemories();
      return json(existing);
    }
    const snapshot: RepositorySnapshot = {
      version: SCHEMA_VERSION,
      id,
      projectId: this.projectId,
      worktreeId,
      revision: revision?.trim() || null,
      contentHash,
      createdAt: new Date().toISOString(),
      fileCount: files.length,
      languages: [],
      coverage: { parsed: 0, textOnly: 0, errors },
    };
    const statements: Statement[] = [];
    const vectorChunks: Chunk[] = [];
    const knownFiles = new Set(files.map((file) => file.path));
    for (const file of files) {
      const cached = await this.db.get<Payload>(
        "SELECT payload FROM files WHERE path=? AND content_hash=? LIMIT 1",
        [file.path, file.hash],
      );
      let parsed: ParsedFile;
      if (cached && json<ParsedFile>(cached).parserVersion === PARSER_VERSION) {
        parsed = json<ParsedFile>(cached);
        for (const symbol of parsed.symbols) symbol.source.snapshotId = id;
        for (const edge of parsed.edges) edge.source.snapshotId = id;
      } else parsed = await parseFile(file.path, file.text, id);
      for (const edge of parsed.edges)
        if (edge.kind === "imports") {
          edge.to = null;
          edge.evidence = "syntactic";
          const match = edge.target.match(
            /(?:from\s+|import\s+)(['"])(\.[^'"]+)\1/,
          );
          if (match && ["typescript", "javascript"].includes(parsed.language)) {
            const target = posix.normalize(
              posix.join(posix.dirname(file.path), match[2]!),
            );
            const candidates = [
              target,
              ...[
                ".ts",
                ".tsx",
                ".js",
                ".jsx",
                ".mts",
                ".cts",
                ".mjs",
                ".cjs",
              ].map((extension) => target + extension),
              ...[".ts", ".tsx", ".js", ".jsx"].map((extension) =>
                posix.join(target, "index" + extension),
              ),
            ];
            const resolved = candidates.filter((candidate) =>
              knownFiles.has(candidate),
            );
            // Only bind an unambiguous concrete file. Package exports, path
            // aliases, generated sources and overloaded resolution stay unresolved.
            if (resolved.length === 1) {
              edge.to = hash(`file:${resolved[0]}`);
              edge.evidence = "resolved";
            }
          }
        }
      snapshot.coverage[parsed.parsed ? "parsed" : "textOnly"]++;
      snapshot.coverage.errors.push(...parsed.errors);
      if (!snapshot.languages.includes(parsed.language))
        snapshot.languages.push(parsed.language);
      statements.push({
        sql: "INSERT INTO files(snapshot_id,path,content_hash,payload) VALUES(?,?,?,?)",
        params: [id, file.path, file.hash, JSON.stringify(parsed)],
      });
      for (const symbol of parsed.symbols)
        statements.push({
          sql: "INSERT INTO symbols(snapshot_id,id,name,payload) VALUES(?,?,?,?)",
          params: [id, symbol.id, symbol.name, JSON.stringify(symbol)],
        });
      for (const edge of parsed.edges)
        statements.push({
          sql: "INSERT INTO edges(snapshot_id,id,source_id,target_id,payload) VALUES(?,?,?,?,?)",
          params: [id, edge.id, edge.from, edge.to, JSON.stringify(edge)],
        });
      for (const chunk of chunkFile(parsed, id)) {
        statements.push({
          sql: "INSERT INTO chunks(id,snapshot_id,path,content_hash,text,payload) VALUES(?,?,?,?,?,?)",
          params: [
            chunk.id,
            id,
            file.path,
            file.hash,
            chunk.text,
            JSON.stringify(chunk),
          ],
        });
        statements.push({
          sql: "INSERT INTO chunks_fts(id,snapshot_id,path,text) VALUES(?,?,?,?)",
          params: [chunk.id, id, file.path, chunk.text],
        });
        vectorChunks.push(chunk);
      }
    }
    snapshot.languages.sort();
    statements.unshift({
      sql: "INSERT INTO snapshots(id,project_id,payload) VALUES(?,?,?)",
      params: [id, this.projectId, JSON.stringify(snapshot)],
    });
    statements.push({
      sql: "INSERT OR REPLACE INTO context_metadata(key,value) VALUES(?,?)",
      params: ["currentSnapshot", id],
    });
    const inserted = await this.db.snapshotBatch(id, statements);
    if (!inserted) {
      await this.db.run(
        "INSERT OR REPLACE INTO context_metadata(key,value) VALUES(?,?)",
        ["currentSnapshot", id],
      );
      await this.importSharedMemories();
      return json<RepositorySnapshot>(
        (await this.db.get<Payload>(
          "SELECT payload FROM snapshots WHERE id=? AND project_id=?",
          [id, this.projectId],
        ))!,
      );
    }
    await this.embedChunks(id, vectorChunks);
    await this.importSharedMemories();
    return snapshot;
  }
  private async embedChunks(
    snapshotId: string,
    chunks: Chunk[],
  ): Promise<void> {
    if (this.vectorError || !(await this.embeddings.available())) return;
    for (const chunk of chunks) {
      const cacheKey = hash(`${EMBEDDING_KEY}:${chunk.text}`);
      const existing = await this.db.get(
        "SELECT cache_key FROM embeddings WHERE cache_key=?",
        [cacheKey],
      );
      if (!existing) {
        const vector = await this.embeddings.embed(chunk.text);
        if (!vector) return;
        await this.db.run(
          "INSERT OR IGNORE INTO embeddings(cache_key,model,dimensions,vector) VALUES(?,?,?,?)",
          [
            cacheKey,
            EMBEDDING_KEY,
            EMBEDDING_DIMENSIONS,
            Buffer.from(vector.buffer),
          ],
        );
      }
      await this.db.run(
        "INSERT OR REPLACE INTO chunk_embeddings(snapshot_id,chunk_id,cache_key) VALUES(?,?,?)",
        [snapshotId, chunk.id, cacheKey],
      );
    }
  }
  async provisionEmbeddings(): Promise<{
    model: string;
    revision: string;
    directory: string;
  }> {
    await this.ready;
    const result = await this.embeddings.provision(this.policy);
    for (const snapshot of await this.listSnapshots()) {
      const chunks = await this.db.all<Payload>(
        "SELECT payload FROM chunks WHERE snapshot_id=?",
        [snapshot.id],
      );
      await this.embedChunks(
        snapshot.id,
        chunks.map((row) => json<Chunk>(row)),
      );
    }
    return result;
  }
  async listSnapshots(): Promise<RepositorySnapshot[]> {
    await this.ready;
    return (
      await this.db.all<Payload>(
        "SELECT payload FROM snapshots WHERE project_id=? ORDER BY rowid DESC",
        [this.projectId],
      )
    ).map((row) => json<RepositorySnapshot>(row));
  }
  private async snapshot(id?: string): Promise<RepositorySnapshot> {
    await this.ready;
    if (!id) return this.index();
    const row = await this.db.get<Payload>(
      "SELECT payload FROM snapshots WHERE id=? AND project_id=?",
      [id, this.projectId],
    );
    if (!row)
      throw new Error(
        "Snapshot does not belong to this project or is unavailable",
      );
    return json(row);
  }
  async searchSymbols(
    query: string,
    snapshotId?: string,
  ): Promise<CodeSymbol[]> {
    const snapshot = await this.snapshot(snapshotId);
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    return (
      await this.db.all<Payload>(
        "SELECT payload FROM symbols WHERE snapshot_id=? AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 100",
        [snapshot.id, `%${escaped}%`],
      )
    )
      .map((row) => json<CodeSymbol>(row))
      .filter((symbol) => !this.excluded(symbol.source.path));
  }
  async neighbors(
    symbolId: string,
    snapshotId?: string,
    depth = 1,
  ): Promise<GraphEdge[]> {
    const snapshot = await this.snapshot(snapshotId);
    if (!Number.isInteger(depth) || depth < 1 || depth > 3)
      throw new Error("Graph depth must be between 1 and 3");
    let frontier = [symbolId];
    const visited = new Set<string>();
    const edges = new Map<string, GraphEdge>();
    for (
      let hop = 0;
      hop < depth && frontier.length && edges.size < 200;
      hop++
    ) {
      const next: string[] = [];
      for (const symbol of frontier.slice(0, 100)) {
        if (visited.has(symbol)) continue;
        visited.add(symbol);
        const rows = await this.db.all<Payload>(
          "SELECT payload FROM edges WHERE snapshot_id=? AND (source_id=? OR target_id=?) LIMIT 200",
          [snapshot.id, symbol, symbol],
        );
        for (const row of rows) {
          const edge = json<GraphEdge>(row);
          if (this.excluded(edge.source.path)) continue;
          edges.set(edge.id, edge);
          next.push(edge.from);
          if (edge.to) next.push(edge.to);
          if (edges.size >= 200) break;
        }
      }
      frontier = next;
    }
    return [...edges.values()].slice(0, 200);
  }
  async getContext(input: {
    query: string;
    budgetTokens?: number;
    snapshotId?: string;
    mandatory?: string[];
  }): Promise<ContextPacket> {
    const snapshot = await this.snapshot(input.snapshotId);
    const budget = input.budgetTokens ?? this.policy.maxContextTokens;
    if (
      !Number.isInteger(budget) ||
      budget < 1 ||
      budget > this.policy.maxContextTokens
    )
      throw new Error("Context budget is outside project policy");
    if (containsSecret(input.query) || input.mandatory?.some(containsSecret))
      throw new Error("Context request contains a credential pattern");
    const memories = (await this.listMemories()).filter(
      (memory) => memory.status === "accepted",
    );
    const mandatoryMemories = memories.filter((memory) =>
      ["constraint", "requirement"].includes(memory.kind),
    );
    const mandatory = [
      ...new Set([
        ...(input.mandatory ?? []),
        ...mandatoryMemories.map((memory) => memory.text),
      ]),
    ];
    const mandatorySources = mandatoryMemories.map((memory) => ({
      text: memory.text,
      visibility: memory.visibility,
      sources: memory.sources,
    }));
    let used =
      estimateTokens(input.query) +
      mandatory.reduce((total, text) => total + estimateTokens(text), 0) +
      64;
    if (used > budget)
      throw new Error(
        `Mandatory context needs at least ${used} tokens; budget is ${budget}. Increase the permitted budget or refine the task.`,
      );
    const candidates = new Map<string, ContextItem>();
    const terms = [
      ...new Set(input.query.match(/[\p{L}\p{N}_]{2,}/gu) ?? []),
    ].slice(0, 24);
    if (terms.length) {
      const match = terms
        .map((term) => `"${term.replaceAll('"', '""')}"`)
        .join(" OR ");
      const rows = await this.db.all<Payload & { rank: number }>(
        "SELECT c.payload, bm25(chunks_fts,0,0,4,1) AS rank FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.id AND c.snapshot_id=chunks_fts.snapshot_id WHERE chunks_fts MATCH ? AND chunks_fts.snapshot_id=? ORDER BY rank LIMIT 80",
        [match, snapshot.id],
      );
      rows.forEach((row, index) => {
        const chunk = json<Chunk>(row);
        if (!this.excluded(chunk.source.path))
          candidates.set(chunk.id, {
            ...chunk,
            kind: /\.(?:md|txt|rst|adoc)$/i.test(chunk.source.path)
              ? "document"
              : "code",
            score: 1 / (60 + index),
          });
      });
    }
    let semantic = false;
    const warnings = [...snapshot.coverage.errors];
    if (!this.vectorError) {
      const queryVector = await this.embeddings.embed(input.query);
      if (queryVector) {
        const rows = await this.db.all<Payload & { distance: number }>(
          "SELECT c.payload, vec_distance_cosine(e.vector,?) AS distance FROM chunks c JOIN chunk_embeddings ce ON ce.snapshot_id=c.snapshot_id AND ce.chunk_id=c.id JOIN embeddings e ON e.cache_key=ce.cache_key WHERE c.snapshot_id=? AND e.model=? ORDER BY distance LIMIT 80",
          [Buffer.from(queryVector.buffer), snapshot.id, EMBEDDING_KEY],
        );
        semantic = rows.length > 0;
        rows.forEach((row, index) => {
          const chunk = json<Chunk>(row);
          if (!this.excluded(chunk.source.path))
            candidates.set(chunk.id, {
              ...chunk,
              kind: "code",
              score: (candidates.get(chunk.id)?.score ?? 0) + 1 / (60 + index),
            });
        });
      } else warnings.push(this.embeddings.warning);
    } else warnings.push(`Vector extension unavailable: ${this.vectorError}`);
    for (const memory of memories.filter(
      (memory) => !["constraint", "requirement"].includes(memory.kind),
    )) {
      const matches = terms.filter((term) =>
        memory.text.toLowerCase().includes(term.toLowerCase()),
      ).length;
      if (matches)
        candidates.set(memory.id, {
          id: memory.id,
          kind: "memory",
          text: memory.text,
          memoryId: memory.id,
          score: matches / Math.max(terms.length, 1) / 50,
        });
    }
    const topPaths = [
      ...new Set(
        [...candidates.values()]
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .flatMap((item) => (item.source ? [item.source.path] : [])),
      ),
    ];
    for (const path of topPaths) {
      const related = await this.neighbors(
        hash(`file:${path}`),
        snapshot.id,
        1,
      );
      for (const edge of related.slice(0, 10)) {
        const target = edge.to
          ? await this.db.get<Payload>(
              "SELECT payload FROM symbols WHERE snapshot_id=? AND id=?",
              [snapshot.id, edge.to],
            )
          : undefined;
        const path = target
          ? json<CodeSymbol>(target).source.path
          : edge.source.path;
        if (this.excluded(path)) continue;
        const rows = await this.db.all<Payload>(
          "SELECT payload FROM chunks WHERE snapshot_id=? AND path=? LIMIT 8",
          [snapshot.id, path],
        );
        for (const row of rows) {
          const chunk = json<Chunk>(row);
          if (!candidates.has(chunk.id))
            candidates.set(chunk.id, {
              ...chunk,
              kind: "code",
              score: 1 / 150,
            });
        }
      }
    }
    const items: ContextItem[] = [];
    const textHashes = new Set<string>();
    for (const candidate of [...candidates.values()].sort(
      (a, b) => b.score - a.score || a.id.localeCompare(b.id),
    )) {
      const digest = hash(candidate.text);
      if (textHashes.has(digest)) continue;
      const size =
        estimateTokens(candidate.text) +
        estimateTokens(candidate.source?.path ?? "") +
        48;
      if (used + size > budget) continue;
      used += size;
      textHashes.add(digest);
      items.push(candidate);
    }
    if (candidates.size > items.length)
      warnings.push(
        "Some candidates were omitted by the context budget or deduplication",
      );
    warnings.push(
      "Token estimate is a conservative UTF-8 byte bound; provider message framing is budgeted separately",
    );
    if (input.snapshotId)
      warnings.push(
        "Explicit snapshot requested: evidence represents that snapshot, not necessarily current working files",
      );
    return {
      version: SCHEMA_VERSION,
      projectId: this.projectId,
      snapshotId: snapshot.id,
      query: input.query,
      mandatory,
      mandatorySources,
      items,
      estimatedTokens: used,
      budgetTokens: budget,
      coverage: {
        semantic,
        graph:
          "Syntax-based declarations, imports and calls; unambiguous relative JS/TS imports resolve to files. Other imports and calls remain unresolved. Expansion limited to 1 hop, 5 seed files.",
        warnings,
      },
    };
  }
  async listMemories(): Promise<MemoryRecord[]> {
    await this.ready;
    return (
      await this.db.all<Payload>(
        "SELECT payload FROM memories WHERE project_id=? ORDER BY rowid",
        [this.projectId],
      )
    ).map((row) => json<MemoryRecord>(row));
  }
  private validateMemory(record: MemoryRecord): void {
    if (
      record.version !== SCHEMA_VERSION ||
      record.projectId !== this.projectId ||
      !/^[a-zA-Z0-9_-]{8,80}$/.test(record.id) ||
      ![
        "observation",
        "decision",
        "requirement",
        "constraint",
        "solution",
      ].includes(record.kind) ||
      typeof record.text !== "string" ||
      !record.text.trim() ||
      record.text.length > 100000 ||
      containsSecret(record.text)
    )
      throw new Error("Invalid or sensitive memory record");
    if (
      !Array.isArray(record.sources) ||
      record.sources.some(
        (source) =>
          !safePath(source.path) ||
          this.excluded(source.path) ||
          !Number.isInteger(source.startLine) ||
          !Number.isInteger(source.endLine) ||
          source.startLine < 1 ||
          source.endLine < source.startLine ||
          typeof source.contentHash !== "string" ||
          typeof source.snapshotId !== "string",
      )
    )
      throw new Error("Memory has an invalid or excluded source");
    if (record.supersedes && !/^[a-zA-Z0-9_-]{8,80}$/.test(record.supersedes))
      throw new Error("Invalid superseded memory id");
  }
  async createMemory(input: {
    text: string;
    kind: MemoryKind;
    sources?: SourceReference[];
    supersedes?: string;
  }): Promise<MemoryRecord> {
    await this.ready;
    const record: MemoryRecord = {
      version: SCHEMA_VERSION,
      id: randomUUID(),
      projectId: this.projectId,
      kind: input.kind,
      text: input.text,
      visibility: "private",
      status: "proposed",
      createdAt: new Date().toISOString(),
      sources: input.sources ?? [],
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    };
    this.validateMemory(record);
    if (record.supersedes) await this.memory(record.supersedes);
    for (const source of record.sources) {
      await this.snapshot(source.snapshotId);
      const file = await this.db.get<Payload>(
        "SELECT payload FROM files WHERE snapshot_id=? AND path=? AND content_hash=?",
        [source.snapshotId, source.path, source.contentHash],
      );
      if (
        !file ||
        source.endLine > json<ParsedFile>(file).text.split("\n").length
      )
        throw new Error("Memory source does not match indexed evidence");
    }
    await this.db.run(
      "INSERT INTO memories(id,project_id,status,payload) VALUES(?,?,?,?)",
      [record.id, this.projectId, record.status, JSON.stringify(record)],
    );
    return record;
  }
  private async memory(id: string): Promise<MemoryRecord> {
    const row = await this.db.get<Payload>(
      "SELECT payload FROM memories WHERE id=? AND project_id=?",
      [id, this.projectId],
    );
    if (!row) throw new Error("Memory is unavailable in this project");
    return json(row);
  }
  async acceptMemory(id: string): Promise<MemoryRecord> {
    await this.ready;
    const record = await this.memory(id);
    if (record.status === "superseded" || record.status === "conflicted")
      throw new Error("A superseded or conflicted memory cannot be accepted");
    this.validateMemory(record);
    if (record.status === "accepted") return record;
    record.status = "accepted";
    const statements: Statement[] = [];
    if (record.supersedes) {
      const previous = await this.memory(record.supersedes);
      if (previous.status !== "accepted")
        throw new Error("Only an accepted memory can be superseded");
      previous.status = "superseded";
      statements.push({
        sql: "UPDATE memories SET status=?,payload=? WHERE id=? AND project_id=?",
        params: [
          previous.status,
          JSON.stringify(previous),
          previous.id,
          this.projectId,
        ],
      });
    }
    statements.push({
      sql: "UPDATE memories SET status=?,payload=? WHERE id=? AND project_id=?",
      params: [record.status, JSON.stringify(record), id, this.projectId],
    });
    await this.db.batch(statements);
    return record;
  }
  async promoteMemory(
    id: string,
  ): Promise<{ path: string; record: MemoryRecord }> {
    await this.ready;
    const record = await this.memory(id);
    this.validateMemory(record);
    if (record.status !== "accepted")
      throw new Error("Only accepted memories can be shared");
    record.visibility = "shared";
    const directory = join(this.root, ".graph", "knowledge");
    await mkdir(directory, { recursive: true });
    const canonicalRoot = await realpath(this.root);
    if (!(await realpath(directory)).startsWith(canonicalRoot + sep))
      throw new Error("Shared knowledge directory escapes the project");
    const path = `.graph/knowledge/${id}.json`,
      absolute = join(this.root, path);
    const output = JSON.stringify(record, null, 2) + "\n";
    try {
      await writeFile(absolute, output, { flag: "wx", mode: 0o644 });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST" &&
        (await readFile(absolute, "utf8")) === output
      ))
        throw error;
    }
    await this.db.run(
      "UPDATE memories SET payload=? WHERE id=? AND project_id=?",
      [JSON.stringify(record), id, this.projectId],
    );
    return { path, record };
  }
  async importSharedMemories(): Promise<number> {
    await this.ready;
    const directory = join(this.root, ".graph", "knowledge");
    let entries: string[];
    try {
      if (
        !(await realpath(directory)).startsWith(
          (await realpath(this.root)) + sep,
        )
      )
        throw new Error("Shared knowledge directory escapes the project");
      entries = await readdir(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return 0;
      throw error;
    }
    let imported = 0;
    for (const name of entries.sort()) {
      if (!/^[a-zA-Z0-9_-]{8,80}\.json$/.test(name)) continue;
      const path = join(directory, name),
        info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 150000)
        continue;
      const record = JSON.parse(await readFile(path, "utf8")) as MemoryRecord;
      this.validateMemory(record);
      if (
        record.id !== name.slice(0, -5) ||
        record.visibility !== "shared" ||
        !["accepted", "superseded", "conflicted"].includes(record.status)
      )
        throw new Error(`Invalid shared memory ${name}`);
      const existing = await this.db.get<Payload>(
        "SELECT payload FROM memories WHERE id=? AND project_id=?",
        [record.id, this.projectId],
      );
      if (existing) {
        const previous = json<MemoryRecord>(existing);
        if (
          previous.text !== record.text ||
          previous.kind !== record.kind ||
          JSON.stringify(previous.sources) !== JSON.stringify(record.sources) ||
          previous.supersedes !== record.supersedes
        ) {
          previous.status = "conflicted";
          await this.db.run(
            "UPDATE memories SET status=?,payload=? WHERE id=? AND project_id=?",
            [
              previous.status,
              JSON.stringify(previous),
              previous.id,
              this.projectId,
            ],
          );
        }
        continue;
      }
      // Shared files are explicit reviewed project knowledge. Imported records
      // retain their accepted status; they never silently overwrite local text.
      await this.db.run(
        "INSERT INTO memories(id,project_id,status,payload) VALUES(?,?,?,?)",
        [record.id, this.projectId, record.status, JSON.stringify(record)],
      );
      imported++;
    }
    // Supersession is explicit and applied only after all referenced files load.
    for (const record of await this.listMemories())
      if (record.status === "accepted" && record.supersedes) {
        const previous = await this.memory(record.supersedes);
        if (previous.status === "accepted") {
          previous.status = "superseded";
          await this.db.run(
            "UPDATE memories SET status=?,payload=? WHERE id=? AND project_id=?",
            [
              previous.status,
              JSON.stringify(previous),
              previous.id,
              this.projectId,
            ],
          );
        }
      }
    return imported;
  }
  async close(): Promise<void> {
    try {
      await this.ready;
      await this.indexing;
      await this.embeddings.close();
    } finally {
      await this.db?.close();
    }
  }
}
