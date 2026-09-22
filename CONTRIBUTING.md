# Working together

`dev` is the integration branch. Work on focused feature branches and open pull requests against `dev`; never push directly to `main` or `master`.

```sh
git fetch origin
git switch dev
git pull --ff-only origin dev
git switch -c feat/short-description
npm ci
npm run setup:git
```

Make small, coherent commits with descriptive subjects such as `feat(context): index repository symbols` or `fix(runtime): retain failed verification evidence`. Use your own configured Git identity. Do not add AI co-author trailers or generated attribution footers.

Before a pull request, run `npm run check` and the checks relevant to the changed subsystem. The PR describes the final behavior, migration effects, and verification actually performed. A partner reviews the diff and CI results before integration. Prefer squash merging a single-purpose PR; retain separate commits when they are independently meaningful. Do not force-push shared `dev` history.

Root workspaces include the scaffolding CLI, shared contracts, engine, and dashboard. Graph metadata validators retain standalone package locks; run `npm ci --prefix graph-templates/tools/validate-graph` followed by `npm test --prefix graph-templates/tools/validate-graph`.

The pre-push hook is a local safeguard, not a replacement for GitHub branch protections. Repository administrators should require passing checks and partner review on `dev` and protect `main` from direct pushes.

The repository CODEOWNERS file names both partners. Do not approve your own work through another account or present automated review as partner approval. Keep a PR in draft while required checks or implementation work remain; request partner review when it is ready. Branch protection changes require the repository owner's administration access.

Share durable knowledge through reviewed `.graph/knowledge` changes. Keep personal provider configuration, credentials, sessions, databases, and model files outside Git.
