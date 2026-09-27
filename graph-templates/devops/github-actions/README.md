# devops.github-actions

Deterministically proposes `.github/workflows/ci.yml`. Rendering requires actual
build/test scripts and a matching v2/v3 package lock; missing scripts are errors,
not successful no-ops. Rendering itself runs no commands or GitHub operations.

Defaults are Node 24, trusted branch `dev`, and `includeMigrations: false`.
Branch and environment names must be bounded literal identifiers, never YAML,
shell or GitHub-expression fragments. Unsupported versions fail closed.
Existing custom workflows require an explicit migration plan instead of overwrite.

Automatic PR/push checks use full commit-pinned checkout/setup-node actions,
read-only contents permission, nonpersistent checkout credentials and disabled
npm lifecycle hooks. They reference **no repository or environment secrets**.
Project tests must provide independent local fixtures rather than requiring
production database or authentication credentials.

Optional migrations require all of:

- `includeMigrations: true` at generation.
- An existing `dbMigrate` package script.
- An explicitly named `migrationEnvironment`.
- A manual workflow_dispatch with `run_migrations: true`.
- An exact `expected_database_name` entered for the reviewed target.
- The selected ref exactly matching the trusted `mainBranch`.
- Successful build/test checks before the separate migration job.

The migration checkout uses the same immutable event SHA that passed checks.
The migration job compiles the checked-out source before invoking the runner.
Only its migration step references the `DATABASE_URL` GitHub secret, exposed
as `MIGRATION_DATABASE_URL` with explicit production/acknowledgement/name guards.
Its concurrency group does not cancel an in-progress migration.

An environment name in YAML does **not** configure required reviewers, restrict
deployment branches, provision secrets, or prove approval protection exists.
Partners must separately configure and verify those GitHub settings. No
migration, deployment, publishing, or repository-secret change occurs during
template generation. CI workflow rendering tests do not constitute a live
GitHub Actions run or a human approval.
