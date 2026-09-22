# Publishing and using create-graph-app

An AI-native, composable full-stack engineering template ecosystem — three related pieces built around one core idea: **a template registry is the reusable abstraction; whatever consumes it (an AI agent, a CLI) is just a caller.**

```
Graph-Engineering/
├── reference-app/         The source application every template below is derived from —
│                           an Express + Neon Postgres (Drizzle) + AWS S3 backend.
│                           See REFERENCE_ARCHITECTURE.md for the full analysis.
│
├── graph-templates/       A fine-grained, ~55-node template library for AI-agent
│                           orchestration — each node is a single composable layer
│                           (a repository, a controller, a middleware...) with a full
│                           machine-readable contract. Start at graph-templates/README.md.
│
├── create-graph-app/      An npm-distributed interactive CLI built on the same idea,
│                           at a coarser grain — six complete, working templates
│                           (Next.js, Zustand, shadcn/ui, Express, Neon Postgres, AWS S3)
│                           a human picks from in under two minutes. Start at
│                           create-graph-app/README.md.
│
└── REFERENCE_ARCHITECTURE.md   What reference-app/ actually does, and which of its
                                 conventions the two template systems above preserve
                                 vs. deliberately improve on, and why.
```

`graph-templates/` and `create-graph-app/` intentionally use **different** template metadata schemas — one is built for an AI agent sequencing dozens of fine-grained nodes with a full generate/validate/modify lifecycle, the other for a human answering six questions and getting a working project in one shot. See `create-graph-app/docs/architecture.md` §"Relationship to graph-templates/" for exactly how they relate and why they didn't converge on one shared schema.

This document covers the two things that sit above both subprojects: **publishing `create-graph-app` to npm**, and **how someone downloads/uses it once published**. Everything else (contributing a `graph-templates` node, writing a `create-graph-app` template, the CLI's own command reference) is documented inside each subproject — see the links above.

---

## Publishing `create-graph-app` to npm

`create-graph-app` lives at `./create-graph-app/` and is a complete, tested, buildable npm package already (54 passing tests, verified `npm pack` contents — see its own `README.md`). These are the steps to actually get it onto the public npm registry.

### 0. Prerequisites

- An npm account. Create one free at [npmjs.com/signup](https://www.npmjs.com/signup) if you don't have one, and verify your email — npm refuses to publish from an unverified account.
- Node.js 24 and npm for repository development and release checks. The distributed scaffolding CLI declares its own runtime minimum separately.
- Confirm ownership and availability of the package name before a release. This guide uses `create-graph-app`; choose a scope you control if needed and update package metadata and documentation consistently.

### 1. Log in to npm from this machine

```sh
npm login
```

Follow the browser prompt (or enter username/password/OTP if npm falls back to that flow). Confirm it worked:

```sh
npm whoami
```

should print your npm username, not an auth error.

### 2. Fill in the package metadata npm's registry page shows

`create-graph-app/package.json` currently has no `repository`, `author`, `bugs`, or `homepage` fields — none of these block publishing, but they're what makes the package's npm registry page (and `npm info create-graph-app`) actually useful to someone deciding whether to trust/install it. Before your first publish, add:

```jsonc
// create-graph-app/package.json
{
  "author": "Your Name <you@example.com>",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/your-username/your-repo.git",
    "directory": "create-graph-app",
  },
  "bugs": "https://github.com/your-username/your-repo/issues",
  "homepage": "https://github.com/your-username/your-repo/tree/main/create-graph-app#readme",
}
```

The repository is hosted at `NdahayoKevin25/graph-engineering`. Work on feature branches and open reviewed PRs into `dev`; never push development changes to `main`. See [CONTRIBUTING.md](../CONTRIBUTING.md). Publishing to npm is a separate, explicitly authorized release operation.

### 3. Run the full pre-publish check yourself, before npm does

`npm publish` already runs `prepublishOnly` (`npm run build && npm run test`) automatically, but run it — and the packaging check — by hand first so you see any failure before it blocks a real publish attempt:

```sh
cd create-graph-app
npm install
npm run build
npm test
npm run pack:check
```

All four should succeed (54 tests passing, the pack-contents check reporting every required file present). If anything fails, fix it before continuing — don't publish a broken build.

### 4. Do a real dry run

See exactly what would be uploaded, without uploading anything:

```sh
npm publish --dry-run
```

Skim the file list it prints — it should match `npm run pack:check`'s report (dist/, templates/, schemas/, README.md, LICENSE, CHANGELOG.md — no src/, no tests/, no node_modules/).

### 5. Publish

```sh
npm publish
```

If you're publishing under a **scoped** name (`@yourusername/create-graph-app`) instead of the unscoped `create-graph-app`, scoped packages default to private on npm, so add the public-access flag or the publish will fail:

```sh
npm publish --access public
```

You'll be prompted for a one-time password if you have 2FA enabled (recommended — npm lets you require it for publishing specifically).

### 6. Verify the published package for real

From a completely different, empty directory (not inside this repo — you want to prove it works from what a real user would run):

```sh
cd /tmp
npx create-graph-app@latest --version
npx create-graph-app@latest list
```

Both should work against the version you just published, downloading it fresh rather than using anything cached locally from this development session.

### 7. Publishing an update later

1. Make your changes inside `create-graph-app/`.
2. Update `CHANGELOG.md` with what changed.
3. Bump the version — npm's helper does this and creates the matching git tag in one step (if this is a git repo by then):
   ```sh
   npm version patch   # bug fix — 0.1.0 -> 0.1.1
   npm version minor    # new template or non-breaking feature -> 0.2.0
   npm version major     # breaking CLI/config-format change -> 1.0.0
   ```
4. Repeat steps 3–6 above (build, test, pack:check, dry-run, publish, verify).

Note npm's own rule, not this project's: once a version is published, you cannot publish that exact version number again, and `npm unpublish` is restricted (generally only within 72 hours of publishing, and can be blocked entirely if other packages depend on it) — always bump the version for a real change rather than trying to overwrite one that's live.

---

## Using `create-graph-app` (once published)

This is what a developer with no prior context does, end to end.

### Step 1 — run it (no install needed)

```sh
npx create-graph-app
```

or, using npm's `create` convention (identical result):

```sh
npm create graph-app
```

npm fetches the latest published version and runs it — nothing is installed permanently unless the user chooses a global install later.

### Step 2 — answer the wizard

```Java
┌─────────────────────────────────────────────┐
│ Full-Stack Project Initializer              │
└─────────────────────────────────────────────┘

? What is your project name? › my-app
? What type of project do you want to create? › Full-stack web application
? Select your frontend framework: › Next.js
? Select state management: › Zustand
? Select UI system: › shadcn/ui
? Select backend: › Express.js
? Select database: › Neon PostgreSQL
? Select your file/object storage: › AWS S3
```

A summary screen shows the exact file/dependency/environment-variable/documentation counts before anything is written, with **Create project / Go back / Cancel** as the final choice — nothing is generated until that's confirmed.

### Step 3 — or skip the wizard entirely

For scripting, CI, or just preferring flags:

```sh
npx create-graph-app my-app --non-interactive \
  --frontend nextjs --state zustand --ui shadcn \
  --backend express --database neon --storage s3
```

Any category left out defaults to "none" — non-interactive mode never generates something you didn't explicitly ask for.

### Step 4 — see what you got, before doing anything else

```sh
cd my-app
cat project.config.yaml     # exactly what was selected — your reproducibility record
cat .env.example             # every environment variable your stack needs, no real values
```

### Step 5 — configure and run

```sh
cp .env.example .env
# edit .env — set DATABASE_URL, AWS_* credentials, etc., per docs/SETUP.md
npm run dev
```

For a full-stack project this starts both `apps/web` (Next.js, port 3001) and `apps/api` (Express, port 3000); for a single-selection project (backend-only or frontend-only), it starts the one app directly at the project root.

### Step 6 — read the generated docs

Every generated project ships its own documentation, written for exactly what was selected — not a generic template:

- `README.md` — stack summary and quick start
- `docs/SETUP.md`, `docs/ARCHITECTURE.md`, `docs/ENVIRONMENT.md`, `docs/DEVELOPMENT.md`
- `docs/templates/<id>.md` — one page per template actually selected (e.g. `docs/templates/storage.aws-s3.md`), covering what it generated, how to configure it, security considerations, and how to replace it later

### Step 7 — reproduce or share the exact same setup later

```sh
npx create-graph-app --config project.config.yaml
```

regenerates an equivalent project from the recorded selection — useful for spinning up a second identical environment, or for someone else on a team reproducing your exact stack choice.

### Other commands worth knowing

```sh
npx create-graph-app list                 # see every available template
npx create-graph-app info frontend.nextjs # full metadata for one template
npx create-graph-app my-app --dry-run --non-interactive --backend express  # preview, write nothing
npx create-graph-app validate             # check an existing project.config.yaml against the current registry
```

Full command/flag reference: `create-graph-app/docs/cli.md`. Full getting-started walkthrough: `create-graph-app/docs/getting-started.md`.
