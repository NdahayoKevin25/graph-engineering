import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import picomatch from "picomatch";
import type {
  ContextPacket,
  ProjectPolicy,
  ProviderConfig,
} from "@graph-engineering/contracts";

const protectedPaths = [
  ".git/**",
  ".git",
  ".graph/**",
  ".graph",
  "node_modules/**",
  "**/node_modules/**",
];
export function isAllowedPath(
  relative: string,
  policy: ProjectPolicy,
  forExport = false,
): boolean {
  // Policy matching and filesystem resolution must see exactly the same path.
  // In particular, picomatch does not normalize `./` but path.resolve does.
  const clean = relative;
  if (
    !clean ||
    clean.includes("\\") ||
    clean.includes("\0") ||
    clean.includes(":") ||
    clean.startsWith("/") ||
    clean
      .split("/")
      .some(
        (s) =>
          s === "." ||
          s === ".." ||
          s === "" ||
          /[. ]$/.test(s) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s),
      )
  )
    return false;
  // Conservatively protect aliases even on case-sensitive machines; projects
  // routinely move to default case-insensitive macOS/Windows filesystems.
  if (
    [...protectedPaths, ...policy.excludedPaths].some((pattern) =>
      picomatch(pattern, {
        dot: true,
        nocase: true,
        basename: !pattern.includes("/"),
      })(clean),
    )
  )
    return false;
  return (
    !forExport ||
    (policy.exportPaths.length > 0 &&
      picomatch(policy.exportPaths, { dot: true })(clean))
  );
}
export async function safePath(
  root: string,
  relative: string,
  policy: ProjectPolicy,
): Promise<string> {
  if (!isAllowedPath(relative, policy))
    throw new Error(`Path is outside allowed project scope: ${relative}`);
  const base = await realpath(root);
  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("Path escapes workspace");
  let current = base;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Symlink is outside managed file scope: ${relative}`);
      const canonical = path
        .relative(base, await realpath(current))
        .split(path.sep)
        .join("/");
      if (!isAllowedPath(canonical, policy))
        throw new Error(
          `Resolved path is outside allowed project scope: ${relative}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}
export function containsSecret(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b|(?:password|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*["']?(?!\$\{|process\.env|os\.environ|<|example|placeholder|your[-_]|test[-_]|undefined|null)[A-Za-z0-9+/_=-]{16,}/i.test(
    text,
  );
}
export function redact(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
      "[REDACTED]",
    )
    .replace(
      /((?:password|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*)["']?[^\s"']{12,}["']?/gi,
      "$1[REDACTED]",
    );
}
export function assertEndpoint(
  endpoint: string,
  policy: ProjectPolicy,
  localOnly = false,
): URL {
  const url = new URL(endpoint);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password)
    throw new Error("Credentials in endpoint URLs are prohibited");
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Unsupported endpoint protocol");
  if (localOnly && !loopback)
    throw new Error("Local providers must use loopback endpoints");
  if (
    !loopback &&
    (policy.inference === "local" ||
      policy.network === "deny" ||
      url.protocol !== "https:" ||
      !policy.allowedHosts.includes(url.hostname))
  )
    throw new Error(`Project policy denies endpoint ${url.hostname}`);
  return url;
}
export function assertProvider(
  provider: ProviderConfig,
  policy: ProjectPolicy,
  effort?: string,
): void {
  if (!policy.providers.includes(provider.id))
    throw new Error(`Project policy does not allow provider ${provider.id}`);
  if (
    provider.kind !== "local" &&
    (policy.inference === "local" || policy.network === "deny")
  )
    throw new Error(
      "Offline policy excludes cloud and installed-agent workers",
    );
  if (effort && !(provider.efforts ?? []).includes(effort))
    throw new Error(`Unsupported effort ${effort} for ${provider.id}`);
  if (provider.kind === "local")
    assertEndpoint(
      provider.endpoint ?? "http://127.0.0.1:11434/v1",
      policy,
      true,
    );
  else if (provider.kind === "openai")
    assertEndpoint(provider.endpoint ?? "https://api.openai.com/v1", policy);
  else if (provider.kind === "anthropic")
    assertEndpoint(provider.endpoint ?? "https://api.anthropic.com", policy);
  if (
    policy.maxCostUsd !== null &&
    (!["openai", "anthropic", "local"].includes(provider.kind) ||
      provider.inputCostPerMillion === undefined ||
      provider.outputCostPerMillion === undefined)
  )
    throw new Error(
      "This provider cannot support the configured cost budget; configure pricing or use a metered API worker",
    );
}
export function contextForProvider(
  packet: ContextPacket,
  provider: ProviderConfig,
  policy: ProjectPolicy,
): ContextPacket {
  assertProvider(provider, policy);
  if (provider.kind === "local") return packet;
  if (containsSecret(packet.query) || packet.mandatory.some(containsSecret))
    throw new Error("Task or mandatory context contains a potential secret");
  if (
    packet.mandatorySources?.some(
      (item) =>
        item.visibility !== "shared" ||
        item.sources.length === 0 ||
        item.sources.some(
          (source) => !isAllowedPath(source.path, policy, true),
        ),
    )
  )
    throw new Error(
      "Mandatory project memory is private or has unexportable provenance; use a local worker or explicitly share eligible knowledge",
    );
  return {
    ...packet,
    items: packet.items.filter(
      (item) =>
        item.source &&
        isAllowedPath(item.source.path, policy, true) &&
        !containsSecret(item.text),
    ),
    // Local diagnostics can contain non-exportable filenames, parser excerpts,
    // or native-loader paths. Do not forward free-form coverage metadata.
    coverage: {
      semantic: packet.coverage.semantic,
      graph:
        "Syntax-based relationships; limited to explicitly exportable files.",
      warnings: [
        "Cloud packet includes only explicitly exportable source-backed items.",
        "Local indexing diagnostics are not exported.",
        "Token counts remain conservative estimates, not provider-reported usage.",
      ],
    },
  };
}
export function assertPublication(
  policy: ProjectPolicy,
  branch: string,
  remoteHost = "github.com",
): void {
  if (
    /(?:^|\/)(?:main|master)$/.test(branch) ||
    branch.startsWith("-") ||
    !/^[a-zA-Z0-9_./-]+$/.test(branch)
  )
    throw new Error(
      "Publishing to main/master or an invalid branch is prohibited",
    );
  if (policy.publication === "none") throw new Error("Publication is disabled");
  if (
    policy.publication === "draft-pr" &&
    (policy.network === "deny" || !policy.allowedHosts.includes(remoteHost))
  )
    throw new Error("Project policy denies GitHub publication");
}
