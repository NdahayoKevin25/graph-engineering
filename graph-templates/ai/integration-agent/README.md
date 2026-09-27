# ai.integration-agent

**Lighter treatment + no backing nodes.** The registry has no `integrations.*` nodes (`stripe`, `email`, `webhooks`, `third-party-api`); the implemented `api.webhooks` covers only a generic inbound HMAC endpoint. This agent can plan (`integration.schema.json`) but not build. State that limitation plainly whenever invoked — never fabricate a working integration.

**Hands off to.** `ai.testing-agent`.
