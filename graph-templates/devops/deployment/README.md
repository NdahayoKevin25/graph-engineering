# devops.deployment — offline ECS Express Mode plan

This node composes the audited `devops.docker`, `devops.github-actions`, and
`devops.aws` renderers. It proposes Docker/Compose and build-and-test CI files,
the private `deploy/ecs-express-create-service.json` request, and a sanitized
public `deployment.schema.json`. It makes no AWS, Docker, network, provider, or
model call and does not build, push, provision, or deploy an image.

First apply and review `devops.docker` for the chosen port. The composer requires
that exact reviewed Dockerfile **already on disk**; a file proposed in the same
render is not enough because the independent AWS descriptor verifier checks the
pre-apply workspace. Existing custom Dockerfiles, CI workflows, plans, and ECS
requests are not overwritten. The app must have explicit `build` and `test`
scripts, matching package/lock dependencies, a compilable `src/app.ts`, and
the reviewed TypeScript output layout.

Select `target: "ecs-express"`, supply an explicit ISO-8601 UTC `generatedAt`
ending in `Z` for
deterministic plan metadata, the service name and port, an **existing** private
ECR image URI pinned by `@sha256:` digest, distinct same-account execution,
infrastructure, and task role ARNs, two or more distinct subnet IDs, security
group IDs, and an array of full same-region/account Secrets Manager or SSM
secret ARNs (or `[]`). Set `acknowledgeUnverifiedAwsPrerequisites: true` only
after acknowledging those prerequisites still require separate verification.
The CI branch defaults to `dev`; optional migrations require an explicit
protected environment reference and remain manually dispatched. That
environment's actual protection settings are not verified here.

The public schema contains only static file paths, the ECS target, a supplied
metadata timestamp, and fixed `projectName: "redacted"`. Its
`envInventoryComplete: false` explicitly marks `requiredEnvVars: []` as an
**incomplete inventory**, not a claim that
the application needs no variables. Even a valid variable or package name may
embed a private account identifier, so neither is copied. Inspect secret names
locally in the private request and use `devops.environments` for separately
reviewed public declarations. The public schema contains no account number,
ECR image or digest, role ARN, subnet/security-group ID, or secret ARN. The
generated CI workflow only builds and tests; it never publishes to ECR or
deploys ECS.

The ECS request stays private at its existing audited path, including in a
nested application. Cloud context export excludes it even with a broad
`exportPaths` policy, and Git publication refuses it in the current tree or
reachable branch history. Do not commit that request to a feature branch. A
separate operator must verify the image's provenance, IAM trust/policies,
network placement and reachability, `/` health response, secret permissions,
and AWS charges before any independent deployment action. This node provides
no live deployment or production-readiness evidence.

Focused offline checks:

```sh
npm run test -w @graph-engineering/engine -- tests/template-runtime-deployment.test.ts
```
