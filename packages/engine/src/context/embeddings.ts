import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectPolicy } from "@graph-engineering/contracts";

export const EMBEDDING_MODEL = "jinaai/jina-embeddings-v2-base-code";
export const EMBEDDING_REVISION = "516f4baf13dec4ddddda8631e019b5737c8bc250";
export const EMBEDDING_KEY = `${EMBEDDING_MODEL}@${EMBEDDING_REVISION}:fp32:mean:normalized:512`;
export const EMBEDDING_DIMENSIONS = 768;
const ASSETS = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model.onnx",
];

export class LocalEmbeddings {
  readonly directory: string;
  private extractor: any;
  private unavailable: string | undefined;
  private loading?: Promise<boolean>;
  constructor(dataDir: string) {
    this.directory = join(dataDir, "models", "jina-code", EMBEDDING_REVISION);
  }

  async available(): Promise<boolean> {
    if (this.extractor) return true;
    if (this.unavailable) return false;
    this.loading ??= this.load();
    return this.loading;
  }
  get warning(): string {
    return this.unavailable ?? "Local embedding model has not been provisioned";
  }
  private async load(): Promise<boolean> {
    try {
      const manifest = JSON.parse(
        await readFile(join(this.directory, "manifest.json"), "utf8"),
      );
      if (manifest.key !== EMBEDDING_KEY)
        throw new Error("Embedding manifest does not match the pinned model");
      const { pipeline } = await import("@huggingface/transformers");
      this.extractor = await pipeline("feature-extraction", this.directory, {
        local_files_only: true,
        device: "cpu",
        dtype: "fp32",
      });
      return true;
    } catch (error) {
      this.unavailable =
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "Local embedding model has not been provisioned"
          : `Local embeddings unavailable: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }
  async embed(text: string): Promise<Float32Array | null> {
    if (!(await this.available())) return null;
    const tensor = await this.extractor(text, {
      pooling: "mean",
      normalize: true,
      truncation: true,
      max_length: 512,
    });
    const vector = new Float32Array(tensor.data);
    if (
      vector.length !== EMBEDDING_DIMENSIONS ||
      vector.some((value) => !Number.isFinite(value))
    )
      throw new Error("Invalid embedding result");
    return vector;
  }

  // This is deliberately separate from index/retrieval. Every redirect is
  // checked before any request, so a cache miss cannot bypass project policy.
  async provision(
    policy: ProjectPolicy,
  ): Promise<{ model: string; revision: string; directory: string }> {
    if (await this.available())
      return {
        model: EMBEDDING_MODEL,
        revision: EMBEDDING_REVISION,
        directory: this.directory,
      };
    if (policy.network !== "allowlisted")
      throw new Error(
        "Model provisioning requires explicitly allowed download hosts",
      );
    const download = async (
      initial: string,
      target: string,
    ): Promise<string> => {
      let url = new URL(initial);
      for (let redirects = 0; redirects < 8; redirects++) {
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          !policy.allowedHosts.includes(url.hostname)
        )
          throw new Error(
            `Model download host is not allowed: ${url.hostname}`,
          );
        const response = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(120000),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw new Error("Download redirect has no location");
          url = new URL(location, url);
          continue;
        }
        if (!response.ok)
          throw new Error(`Model download failed (${response.status})`);
        if (!response.body) throw new Error("Model download returned no body");
        const temporary = `${target}.${randomUUID()}.tmp`,
          digest = createHash("sha256");
        let bytes = 0;
        const handle = await open(temporary, "wx", 0o600);
        try {
          for await (const part of response.body as any as AsyncIterable<Uint8Array>) {
            bytes += part.length;
            if (bytes > 1_500_000_000)
              throw new Error("Model asset exceeds the download limit");
            digest.update(part);
            await handle.writeFile(part);
          }
          await handle.close();
          await rename(temporary, target);
          return digest.digest("hex");
        } finally {
          await handle.close();
          await rm(temporary, { force: true });
        }
      }
      throw new Error("Too many model download redirects");
    };
    await mkdir(join(this.directory, "onnx"), { recursive: true, mode: 0o700 });
    const digests: Record<string, string> = {};
    for (const asset of ASSETS) {
      digests[asset] = await download(
        `https://huggingface.co/${EMBEDDING_MODEL}/resolve/${EMBEDDING_REVISION}/${asset}`,
        join(this.directory, asset),
      );
    }
    await writeFile(
      join(this.directory, "manifest.json"),
      JSON.stringify({ key: EMBEDDING_KEY, assets: digests }),
      { mode: 0o600 },
    );
    this.unavailable = undefined;
    this.loading = undefined;
    if (!(await this.available())) throw new Error(this.warning);
    return {
      model: EMBEDDING_MODEL,
      revision: EMBEDDING_REVISION,
      directory: this.directory,
    };
  }
  async close(): Promise<void> {
    const extractor = this.extractor;
    this.extractor = undefined;
    this.loading = undefined;
    this.unavailable = "Embedding engine is closed";
    if (extractor?.dispose) await extractor.dispose();
  }
}
