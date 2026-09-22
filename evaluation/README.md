# Reproducible synthetic engineering fixtures

This corpus contains 60 small, explicitly synthetic bug-fix tasks: ten boundary
and arithmetic regressions in each of JavaScript, Python, Go, Rust, Java, and
C#. It is a smoke corpus for the evaluation workflow, not a representative
benchmark of architecture, security, or large-repository reasoning. JavaScript
represents the JS/TS family here; parser tests separately cover TypeScript.
No model outcome or token-saving claim ships with these fixtures.

Every task has a broken program, independent expected outputs, an oracle repair
for fixture validation, and an external verification harness. The runner gives
workers only the broken program, objective, and acceptance criteria. Baseline
and candidate receive separate workspaces. Verification mounts those workspaces
and a separate harness read-only in a preprovisioned Docker image with networking
disabled. It does not trust an adapter's claim that tests passed.

```sh
node evaluation/run.mjs --list
node --test evaluation/runner.test.mjs
```

The dependency-free runner tests execute all 20 JavaScript/Python broken and
oracle programs locally. Go, Rust, Java, and C# verification is defined by their
container harnesses and needs those images before an end-to-end run. Provision
the image tags shown by `--list` explicitly; the runner uses `--pull=never`.

## Run actual workers

Build the packages first. The included `api-adapter.mjs` uses the real engine
API-worker code, policy checks, context engine, and guarded patch application.
It supports local OpenAI-compatible, OpenAI, and Anthropic API providers. Each
profile is a private JSON file with:

```json
{
  "contextMode": "graph",
  "baselineProviderId": "local-worker",
  "policy": "replace with a complete reviewed ProjectPolicy object",
  "providers": [
    {
      "id": "local-worker",
      "kind": "local",
      "model": "your-installed-model",
      "endpoint": "http://127.0.0.1:11434/v1"
    }
  ],
  "decisionProviders": []
}
```

Use `contextMode: "full"` in the baseline profile and `"graph"` in the candidate
profile to compare context assembly with the same worker. A candidate profile
can include the local Laya configuration documented in
[decisions.md](../docs/decisions.md). Adding it explicitly enables experimental
routing inside these synthetic fixtures, without promoting production policy.
Cloud profiles need explicit inference, host, provider, and export permissions.
Credentials remain environment variables; never put them in command arguments.

```sh
node evaluation/run.mjs \
  --baseline-command '["node","evaluation/api-adapter.mjs","--profile","/path/to/baseline.json"]' \
  --candidate-command '["node","evaluation/api-adapter.mjs","--profile","/path/to/candidate.json"]' \
  --output /path/to/new-artifact.json
```

Start with `--task javascript-addition` or `--limit 1`. The full run calls real
workers and may incur provider charges. Adapter commands run as explicit local
executables; use trusted adapters. The built-in adapter accepts only proposals
for the fixture's allowed source file. Worker-selected shell commands are never
executed by it. The outer verifier always runs independently.

Other adapters receive one JSON request on stdin with `version`, `taskId`,
`language`, `workspace`, `objective`, `acceptance`, and `allowedFiles`. They edit
that workspace and return exactly one JSON receipt on stdout:

```json
{
  "usage": { "inputTokens": null, "outputTokens": null, "costUsd": null },
  "decisions": [],
  "policyViolation": false
}
```

Report actual usage where available; missing usage stays `null`. The built-in
adapter calculates cost from provider-reported tokens and explicitly configured
pricing. That is a pricing estimate, not a provider billing invoice. Local model
cost is marginal API spend and excludes electricity/hardware. Hosted Jev cost
is currently unavailable through the decision interface, so using it marks
total cost unknown and blocks cost-based promotion. `policyViolation` is an
observed audit signal, not evidence of exhaustive adversarial testing.

## Artifacts and labels

`artifact.schema.json` describes the recorded results. Each variant stores
elapsed time, adapter exit status, observed usage/decisions, and independent
verification results. The runner alternates baseline/candidate order by task
and leaves unknown measurements explicit. Output files use exclusive creation
and will not overwrite an earlier result. Temporary fixture workspaces are
removed after collection.

Image tags are resolved once to a local `sha256:` image identity, and both
variants execute that exact image ID. Artifacts record the image ID, harness
hash, initial and verified source hashes, suite code hash, and per-variant
configuration hash. Profile contents and command arguments are hashed without
being copied into the report. A profile or source change during verification
prevents a successful result.

Decision labels are separate, reviewed input, never inferred from model output:

```json
[
  {
    "taskId": "javascript-addition",
    "caseId": "javascript-addition-worker",
    "category": "worker",
    "split": "held-out",
    "expected": "local-worker"
  }
]
```

Pass `--labels /path/to/labels.json --rows-output /path/to/new-rows.json` to
produce evaluator rows for observed, labeled decisions with known costs. Tasks
without labels or measured costs remain in the raw artifact but contribute no
promotion evidence. Run `graph-engine evaluate <rows.json>` afterward.

One routing decision per task yields only 60 observations, so this corpus alone
cannot meet the required 200 accepted held-out examples per category. Splitting
these tasks into calibration/held-out groups further reduces those counts.
Expand the corpus with distinct, reviewed tasks and separately collected
calibration data before considering promotion. Duplicating existing cases is
rejected by the evaluator. Synthetic gate tests do not count as model evidence.
