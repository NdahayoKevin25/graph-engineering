import { useMemo, useState } from "react";
import { captureToken, createApi } from "./api";
import {
  Button,
  ErrorNotice,
  Icon,
  Loading,
  useResource,
  type IconName,
} from "./components";
import type { ProjectResponse } from "./types";
import { ContextPage } from "./ContextPage";
import { GraphPage } from "./GraphPage";
import { MemoriesPage } from "./MemoriesPage";
import { RunsPage } from "./RunsPage";
import { DecisionsPage } from "./DecisionsPage";

type View = "context" | "graph" | "memories" | "runs" | "decisions";
const views: { id: View; label: string; icon: IconName }[] = [
  { id: "context", label: "Context", icon: "context" },
  { id: "graph", label: "Code graph", icon: "graph" },
  { id: "memories", label: "Memory", icon: "memory" },
  { id: "runs", label: "Runs", icon: "run" },
  { id: "decisions", label: "Decisions & usage", icon: "decision" },
];

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Icon name="graph" size={26} />
      </span>
      <span>
        graph<span className="brand-sub">ENGINEERING</span>
      </span>
    </div>
  );
}

export function App() {
  const [token] = useState(captureToken);
  const api = useMemo(() => createApi(token), [token]);
  const project = useResource<ProjectResponse>(
    api,
    token ? "/api/project" : null,
  );
  const [view, setView] = useState<View>("context");
  const [indexVersion, setIndexVersion] = useState(0);
  const current = views.find((item) => item.id === view)!;

  if (!token)
    return (
      <div className="connection-screen">
        <Brand />
        <div className="connection-card">
          <span className="empty-icon">
            <Icon name="shield" size={28} />
          </span>
          <h1>
            A local workspace.
            <br />A private connection.
          </h1>
          <p>
            Open the dashboard URL printed by your Graph Engineering terminal.
            That link connects this browser to your local engine.
          </p>
          <div className="note">
            Your access token stays in this browser session.
          </div>
        </div>
      </div>
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-switch">
          <span className="workspace-avatar">
            {project.data?.config.name.slice(0, 1).toUpperCase() ?? "G"}
          </span>
          <div>
            <span className="workspace-name">
              {project.data?.config.name ?? "Your workspace"}
            </span>
            <span className="small muted">Local project</span>
          </div>
          <span className="workspace-dot" />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Workspace navigation">
          {views.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setView(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {view === item.id && <span className="nav-indicator" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <Icon name="shield" size={18} />
            <div>
              <strong>Your knowledge stays yours.</strong>
              <p>Context and decisions, stored locally.</p>
            </div>
          </div>
          <div className="sidebar-footer">
            <span className={`status-dot ${project.data ? "" : "offline"}`} />
            <span>
              {project.data ? "Local engine connected" : "Connecting to engine"}
            </span>
            <span className="version">v0.1</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>{project.data?.config.name ?? "Workspace"}</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{current.label}</strong>
          </div>
          <div className="topbar-right">
            <span className="policy-label">
              <span className="status-dot" />
              {project.data?.config.policy.inference === "allowlisted"
                ? "Approved providers"
                : "Local inference"}
            </span>
            <button
              className="icon-button"
              onClick={project.reload}
              aria-label="Refresh project connection"
              title="Refresh project connection"
            >
              <Icon name="refresh" size={17} />
            </button>
          </div>
        </header>
        <main id="main-content">
          <ErrorNotice message={project.error} retry={project.reload} />
          {!project.data && !project.error && <Loading />}
          {project.data && (
            <>
              <section hidden={view !== "context"}>
                <ContextPage
                  api={api}
                  project={project.data}
                  indexed={() => setIndexVersion((value) => value + 1)}
                />
              </section>
              <section hidden={view !== "graph"}>
                <GraphPage
                  api={api}
                  indexVersion={indexVersion}
                  active={view === "graph"}
                />
              </section>
              <section hidden={view !== "memories"}>
                <MemoriesPage api={api} active={view === "memories"} />
              </section>
              <section hidden={view !== "runs"}>
                <RunsPage
                  api={api}
                  project={project.data}
                  active={view === "runs"}
                />
              </section>
              <section hidden={view !== "decisions"}>
                <DecisionsPage api={api} active={view === "decisions"} />
              </section>
            </>
          )}
          {!project.data && project.error && (
            <div className="connection-help">
              <h2>Let’s reconnect your workspace.</h2>
              <p>
                Check that the local engine is running, or open a fresh
                dashboard link from your terminal.
              </p>
              <Button variant="secondary" onClick={project.reload}>
                Reconnect <Icon name="arrow" size={16} />
              </Button>
            </div>
          )}
        </main>
        <footer className="main-footer">
          <span>GRAPH ENGINEERING</span>
          <span>Built around your code. Grounded in evidence.</span>
        </footer>
      </div>
    </div>
  );
}
