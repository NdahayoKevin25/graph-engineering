# ai.devops-agent

**Lighter treatment.** Invokes `devops.docker` + `devops.github-actions` + `devops.environments`. Always runs after `ai.testing-agent` — never containerize/CI-wire untested code. The optional `devops.deployment` node composes an offline ECS Express Mode plan after its reviewed Dockerfile already exists; it does not build, push, provision, publish or deploy.

**Hands off to.** `ai.validation-agent` (final full-graph pass).
