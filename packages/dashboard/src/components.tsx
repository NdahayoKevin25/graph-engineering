import {
  useCallback,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import type { Api } from "./api";
import { getError, readable } from "./view-model";

export type IconName =
  | "context"
  | "graph"
  | "memory"
  | "run"
  | "decision"
  | "arrow"
  | "search"
  | "refresh"
  | "check"
  | "close"
  | "plus"
  | "clock"
  | "folder"
  | "shield";
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    context: (
      <>
        <path d="M4 5h16v14H4zM8 9h8M8 13h5" />
        <path d="M8 3v4M16 3v4" />
      </>
    ),
    graph: (
      <>
        <circle cx="12" cy="5" r="2.5" />
        <circle cx="5" cy="18" r="2.5" />
        <circle cx="19" cy="18" r="2.5" />
        <path d="m11 7-5 8m7-8 5 8M8 18h8" />
      </>
    ),
    memory: (
      <>
        <path d="M6 4h13v17H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 0v13h13M9 8h6M9 11h4" />
      </>
    ),
    run: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m10 8 6 4-6 4V8Z" />
      </>
    ),
    decision: (
      <>
        <path d="M6 4v9a4 4 0 0 0 4 4h8M6 9h6a4 4 0 0 0 4-4V3m-1 11 3 3-3 3" />
        <circle cx="6" cy="4" r="2" />
      </>
    ),
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M19 11a7 7 0 0 0-12-6L4 8m16 8-3 3A7 7 0 0 1 5 13" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6l4 2" />
      </>
    ),
    folder: <path d="M3 6h7l2 2h9v12H3V6Z" />,
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function Button({
  children,
  busy,
  variant = "primary",
  className = "",
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      {...props}
      disabled={disabled || busy}
      className={`button button-${variant} ${className}`}
      aria-busy={busy || undefined}
    >
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "orange" | "red";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Status({ value }: { value: string }) {
  const tone = [
    "accepted",
    "shared",
    "succeeded",
    "resolved",
    "promoted",
  ].includes(value)
    ? "green"
    : ["failed", "conflicted", "needs_reconciliation"].includes(value)
      ? "red"
      : ["running", "verifying", "proposed", "heuristic"].includes(value)
        ? "orange"
        : "neutral";
  return <Badge tone={tone}>{readable(value)}</Badge>;
}

export function ErrorNotice({
  message,
  retry,
}: {
  message?: string | null;
  retry?: () => void;
}) {
  if (!message) return null;
  return (
    <div className="notice notice-error" role="alert">
      <span>{message}</span>
      {retry && (
        <button className="text-button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={25} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Loading({ label = "Loading workspace…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {label}
    </div>
  );
}

export function PageHeading({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
      {action}
    </div>
  );
}

export function useResource<T>(
  api: Api,
  path: string | null,
  refreshKey: unknown = 0,
) {
  const [state, setState] = useState<{
    path: string | null;
    data: T | null;
    error: string | null;
    loading: boolean;
  }>({ path: null, data: null, error: null, loading: false });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!path) {
      setState({ path: null, data: null, error: null, loading: false });
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({
      path,
      data: previous.path === path ? previous.data : null,
      error: null,
      loading: true,
    }));
    api<T>(path, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setState({ path, data: value, error: null, loading: false });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setState((previous) => ({
            ...previous,
            path,
            error: getError(cause),
            loading: false,
          }));
      });
    return () => controller.abort();
  }, [api, path, revision, refreshKey]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  // Never render another symbol's edges or another run's details while the next request begins.
  return {
    ...(state.path === path
      ? state
      : { data: null, error: null, loading: Boolean(path) }),
    reload,
  };
}

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timeout);
  }, [value, delay]);
  return debounced;
}
