# Generate: project.node-express

1. Confirm the target directory is empty or has no `package.json` (see `idempotency.detection`). If `package.json` exists, stop and report this node as already generated — do not overwrite; hand off to `modify` semantics instead (none defined yet for this node beyond re-running downstream nodes).
2. Resolve inputs: `projectName` is required; `description`, `port`, `corsOrigin` fall back to their `template.yaml` defaults.
3. Render every file under `files/` with `{{input.*}}` placeholders substituted, writing to the paths in `template.yaml` `files.create`.
4. Initialize `.graph/manifest.json` at schemaVersion `2.0.0`, keyed by this invocation's `instanceId` (default `project.node-express`), with `templateId`, `version`, `generatedAt`, and `files`. Record only invocations that actually ran.
5. Run `npm install` in the target directory.
6. Run `npm run build` to confirm the scaffold compiles before reporting success.
7. Report outputs: `files` (the list actually written) and `entrypoint: src/app.ts`.
