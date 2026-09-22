import type { InstalledWorkerCapability } from "./types";
import { Badge, Icon } from "./components";
import { readable } from "./view-model";

export function WorkerCapabilities({
  workers,
}: {
  workers?: InstalledWorkerCapability[];
}) {
  if (!workers?.length) return null;
  return (
    <details className="panel worker-capabilities">
      <summary>
        <span>
          <Icon name="shield" size={16} />
          Installed client capabilities
        </span>
        <span className="small muted">
          {workers.filter((worker) => worker.available).length} adapter
          {workers.filter((worker) => worker.available).length === 1
            ? ""
            : "s"}{" "}
          available
        </span>
      </summary>
      <div className="worker-grid">
        {workers.map((worker) => (
          <div className="worker-capability" key={worker.kind}>
            <div>
              <strong>{readable(worker.kind)}</strong>
              <Badge tone={worker.available ? "green" : "neutral"}>
                {worker.available
                  ? "Available"
                  : worker.installed
                    ? "Capability gated"
                    : "Not installed"}
              </Badge>
            </div>
            <p>
              {worker.version
                ? `Version ${worker.version}`
                : "Version not reported"}
              {worker.available ? ` · ${readable(worker.mode)}` : ""}
            </p>
            {worker.available && (
              <p>
                Authentication: {readable(worker.authentication)}.{" "}
                {worker.supportsSubscription
                  ? "Native subscriptions supported."
                  : "API credentials required."}
              </p>
            )}
            {worker.reason && <p>{worker.reason}</p>}
            <ul>
              {worker.limits.map((limit, index) => (
                <li key={index}>{limit}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}
