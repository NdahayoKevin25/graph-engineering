# Installed workers

Installed clients return structured patch proposals. Graph Engineering applies approved replacements in an isolated run workspace and runs verification in Docker. A client receives a filtered context packet through standard input or JSON-RPC, and runs from a newly created empty temporary directory. It never receives the run workspace path. Temporary transport files are removed after completion or cancellation.

`discoverInstalledWorkers()` reports installed versions, availability, authentication, execution mode, and limitations. It runs version/help probes and generates temporary protocol schemas; it never logs in, installs a client, or requests model inference. Availability does not mean authentication or live inference was tested.

## Claude Code

The adapter requires the inspected 2.1.278+ CLI family and its advertised control flags. It uses bare mode, an empty built-in toolset, disabled MCP/skills, isolated settings, disabled session persistence, and a JSON proposal schema. Only the selected Anthropic API credential and a small set of operating-system variables enter the subprocess environment. Tasks are sent through stdin, never process arguments.

Bare mode is deliberately API-key based: this adapter does not reuse subscription OAuth or keychain credentials. The ordinary safe-mode flag is insufficient for this workflow because administrator-managed hooks can remain active. Sources: [CLI controls](https://code.claude.com/docs/en/cli-reference), [hook precedence](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks), [environment controls](https://code.claude.com/docs/en/env-vars). The locally inspected `claude --help` additionally identifies bare authentication as API-key only.

## Codex App Server

This adapter is a restricted-read worker, not a claim that the native runtime exposes zero tools. It checks the installed binary's generated protocol schema for restricted read roots before enabling execution. Ordinary read-only mode without restricted roots is rejected. Codex 0.155.1 inspected during development lacked that schema capability and is therefore reported unavailable on this machine.

For compatible binaries, the adapter disables execution, hooks, apps, plugins, agents, browser/computer access, and configured MCP servers. It verifies effective feature flags and model/effort availability before starting an ephemeral thread. The turn uses `outputSchema`, no network access for sandboxed tools, and read access limited to scratch plus native platform defaults. Approval requests are declined. The client never invokes App Server filesystem, process, shell-command, or configuration-write APIs. Nonempty instruction sources, incompatible managed settings, relaxed sandbox responses, and unexpected tool activity fail the run.

Native authentication remains with Codex; Graph Engineering does not copy or extract its stored credentials. Subscription access depends on the account and supported native integration. See [App Server protocol](https://learn.chatgpt.com/docs/app-server) and [configuration controls](https://learn.chatgpt.com/docs/config-file/config-reference).

## Cursor and budgets

Cursor is reported unavailable for managed proposals. The SDK offers an empty built-in toolset, but independent hook-loading behavior and output-budget enforcement require verification before enabling it. Cursor can still consume Graph Engineering context through MCP. Its SDK requires explicit supported authentication; an installed application does not automatically supply it. See [Cursor SDK](https://cursor.com/docs/sdk/typescript).

All installed workers reject local-only policies and hard monetary caps. Use API workers when precise provider limits are required. Claude's output setting applies per response; Codex usage limits are observed asynchronously and can overshoot before interruption. Missing token or cost telemetry stays `null`. No paid native prompt was used to test this implementation; protocol and failure handling are tested with mocked native transports.
