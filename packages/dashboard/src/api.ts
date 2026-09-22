const TOKEN_KEY = "graph-engineering-token";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return token?.trim() || null;
}

export function captureToken(): string {
  const incoming = tokenFromHash(window.location.hash);
  if (incoming) {
    sessionStorage.setItem(TOKEN_KEY, incoming);
    const clean = new URL(window.location.href);
    clean.hash = "";
    window.history.replaceState(null, "", clean.pathname + clean.search);
  }
  return incoming ?? sessionStorage.getItem(TOKEN_KEY) ?? "";
}

export function createApi(token: string, request: typeof fetch = fetch) {
  return async function api<T>(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!path.startsWith("/api/"))
      throw new Error("Only local API paths are supported.");
    const response = await request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const object =
        data && typeof data === "object"
          ? (data as Record<string, unknown>)
          : null;
      const message =
        typeof object?.error === "string"
          ? object.error
          : typeof object?.message === "string"
            ? object.message
            : response.status === 401
              ? "This session has expired. Open the dashboard link from your terminal again."
              : `The request failed (${response.status}).`;
      throw new ApiError(message, response.status);
    }
    return data as T;
  };
}

export type Api = ReturnType<typeof createApi>;
