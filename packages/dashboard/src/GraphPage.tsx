import { useEffect, useState } from "react";
import type { CodeSymbol, GraphEdge } from "@graph-engineering/contracts";
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
  useDebounced,
  useResource,
} from "./components";
import { shortId } from "./view-model";

function shorten(value: string, length = 25) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function GraphDiagram({
  symbol,
  edges,
}: {
  symbol: CodeSymbol;
  edges: GraphEdge[];
}) {
  const visible = edges.slice(0, 12);
  return (
    <div className="graph-canvas">
      <svg
        viewBox="0 0 740 470"
        role="img"
        aria-label={`${symbol.name}, connected to ${edges.length} relationships. The first ${visible.length} are drawn; all relationships are listed below.`}
      >
        <defs>
          <pattern
            id="graph-dots"
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r="1" fill="#d5d8ce" />
          </pattern>
          <marker
            id="graph-arrow"
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path d="M0 0 6 3 0 6" fill="none" stroke="#9ca38e" />
          </marker>
        </defs>
        <rect width="740" height="470" fill="url(#graph-dots)" />
        <circle
          cx="370"
          cy="235"
          r="114"
          fill="none"
          stroke="#dde1d6"
          strokeDasharray="3 7"
        />
        {visible.map((edge, index) => {
          const angle = (index / visible.length) * 2 * Math.PI - Math.PI / 2;
          const x = 370 + Math.cos(angle) * 246;
          const y = 235 + Math.sin(angle) * 166;
          const inward = edge.from !== symbol.id;
          return (
            <g key={edge.id}>
              <path
                d={
                  inward
                    ? `M ${x} ${y} Q ${370 + Math.cos(angle + 0.2) * 140} ${235 + Math.sin(angle + 0.2) * 100} ${370 + Math.cos(angle) * 63} ${235 + Math.sin(angle) * 63}`
                    : `M ${370 + Math.cos(angle) * 63} ${235 + Math.sin(angle) * 63} Q ${370 + Math.cos(angle + 0.2) * 140} ${235 + Math.sin(angle + 0.2) * 100} ${x - Math.cos(angle) * 13} ${y - Math.sin(angle) * 13}`
                }
                fill="none"
                stroke={edge.evidence === "resolved" ? "#72855a" : "#a8ad9e"}
                strokeWidth="1.3"
                strokeDasharray={edge.to ? undefined : "5 5"}
                markerEnd="url(#graph-arrow)"
              />
              <circle
                cx={x}
                cy={y}
                r="9"
                fill={edge.to ? "#e1e7d6" : "#fbfaf5"}
                stroke="#8b9975"
                strokeWidth="1.5"
              />
              <text
                x={x}
                y={y + 27}
                textAnchor="middle"
                className="graph-node-label"
              >
                {shorten(inward ? edge.from : edge.target)}
              </text>
              <text
                x={x}
                y={y + 43}
                textAnchor="middle"
                className="graph-edge-label"
              >
                {inward ? "incoming " : ""}
                {edge.kind}
              </text>
              <title>
                {edge.target} — {edge.kind}, {edge.evidence}
                {edge.to ? "" : ", unresolved target"}
              </title>
            </g>
          );
        })}
        <circle
          cx="370"
          cy="235"
          r="65"
          fill="#eef1e5"
          stroke="#829668"
          strokeWidth="1.5"
        />
        <circle cx="370" cy="235" r="57" fill="#344c37" />
        <text
          x="370"
          y="233"
          textAnchor="middle"
          className="graph-center-label"
        >
          {shorten(symbol.name, 17)}
        </text>
        <text x="370" y="252" textAnchor="middle" className="graph-center-kind">
          {symbol.kind}
        </text>
      </svg>
      <div className="graph-legend">
        <span>
          <i className="legend-line" />
          Relationship
        </span>
        <span>
          <i className="legend-line dashed" />
          Unresolved target
        </span>
        {edges.length > 12 && <span>Showing 12 of {edges.length}</span>}
      </div>
    </div>
  );
}

export function GraphPage({
  api,
  indexVersion,
  active,
}: {
  api: Api;
  indexVersion: number;
  active: boolean;
}) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query);
  const symbols = useResource<CodeSymbol[]>(
    api,
    active ? `/api/symbols?q=${encodeURIComponent(debounced)}` : null,
    indexVersion,
  );
  const [selected, setSelected] = useState<CodeSymbol | null>(null);
  const edges = useResource<GraphEdge[]>(
    api,
    active && selected
      ? `/api/neighbors?symbolId=${encodeURIComponent(selected.id)}&snapshotId=${encodeURIComponent(selected.source.snapshotId)}`
      : null,
    indexVersion,
  );
  useEffect(() => setSelected(null), [indexVersion]);
  return (
    <>
      <PageHeading eyebrow="CODE GRAPH" title="Follow the connections.">
        Explore symbols and their relationships, with the evidence behind every
        edge.
      </PageHeading>
      <div className="graph-layout">
        <div className="panel symbol-panel">
          <div className="panel-heading">
            <h2>Find a symbol</h2>
            <Badge>{symbols.data?.length ?? "—"}</Badge>
          </div>
          <label className="compact-search">
            <Icon name="search" size={17} />
            <input
              aria-label="Search code symbols"
              placeholder="Name, path, or signature…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <ErrorNotice message={symbols.error} retry={symbols.reload} />
          {symbols.loading ? (
            <Loading label="Finding symbols…" />
          ) : (
            <div className="symbol-list">
              {symbols.data?.map((symbol) => (
                <button
                  className={`symbol-option ${selected?.id === symbol.id ? "selected" : ""}`}
                  key={symbol.id}
                  onClick={() => setSelected(symbol)}
                >
                  <span className="symbol-glyph">
                    {symbol.kind === "class" ? "C" : "ƒ"}
                  </span>
                  <span>
                    <strong>{symbol.name}</strong>
                    <span className="symbol-path">
                      {symbol.source.path}:{symbol.source.startLine}
                    </span>
                  </span>
                  <span className="symbol-language">{symbol.language}</span>
                </button>
              ))}
              {!symbols.data?.length && (
                <EmptyState icon="search" title="No symbols found">
                  Update the project index or try a different name.
                </EmptyState>
              )}
            </div>
          )}
        </div>
        <div className="graph-detail">
          {selected ? (
            <>
              <div className="panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">
                      {selected.language} / {selected.kind}
                    </div>
                    <h2 className="break-word">{selected.name}</h2>
                    <p className="mono break-word">
                      {selected.source.path}:{selected.source.startLine}
                    </p>
                  </div>
                  <Badge>Snapshot {shortId(selected.source.snapshotId)}</Badge>
                </div>
                <ErrorNotice message={edges.error} retry={edges.reload} />
                {edges.loading ? (
                  <Loading label="Tracing connections…" />
                ) : (
                  <GraphDiagram symbol={selected} edges={edges.data ?? []} />
                )}
                {selected.signature && (
                  <pre className="signature">{selected.signature}</pre>
                )}
              </div>
              <div className="panel">
                <div className="panel-heading">
                  <h2>Relationships</h2>
                  <span className="small muted">
                    {edges.data?.length ?? 0} edges
                  </span>
                </div>
                <p className="evidence-note">
                  Syntactic links describe the source. They do not guarantee
                  every runtime call target.
                </p>
                <div className="edge-list">
                  {!edges.loading &&
                    edges.data?.map((edge) => (
                      <div className="edge-row" key={edge.id}>
                        <span className="edge-kind">
                          {edge.from === selected.id ? "→" : "←"} {edge.kind}
                        </span>
                        <div>
                          <strong className="mono break-word">
                            {edge.target}
                          </strong>
                          <span className="small muted break-word">
                            {edge.source.path}:{edge.source.startLine}
                            {edge.to ? "" : " · target unresolved"}
                          </span>
                        </div>
                        <Status value={edge.evidence} />
                        <Button
                          variant="ghost"
                          onClick={() => setQuery(edge.target)}
                          title={`Search for ${edge.target}`}
                          aria-label={`Search for ${edge.target}`}
                        >
                          <Icon name="search" size={15} />
                        </Button>
                      </div>
                    ))}
                  {!edges.loading && !edges.data?.length && (
                    <p className="inline-hint">
                      No relationships were recorded for this symbol.
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="panel graph-placeholder">
              <EmptyState icon="graph" title="Every connection has a story">
                Select a symbol to explore its neighborhood. Imports,
                references, and calls keep their source locations and evidence
                labels.
              </EmptyState>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
