# Codex agents

Codex `0.160.0` runs in every workspace image, regardless of selected runtimes. Repellet supervises its app-server and uses Codex's built-in tools, conversations, history, and compaction. Open **Agent settings** from the account menu, or open **Agent** in a running workspace and use its settings button.

## Accounts and providers

**Sign in with ChatGPT** shows Codex's verification link and one-time code. Codex owns device-code polling, OAuth refresh, cancellation, and credential persistence. Enable device-code login in your ChatGPT account if the verification page asks you to. Reconnect in Agent settings if authentication expires or the pinned credential cache becomes incompatible. Disconnecting ChatGPT interrupts agent work across your projects.

**Custom API** requires a Responses API base URL, an API key, and a model ID. Include the API path in the base URL; private-network HTTP endpoints are accepted. Embedded credentials, query strings, and fragments are rejected. Reasoning effort is optional. The API key is stored in plaintext in private worker storage, as requested. Reads report only whether a key is saved. Leaving the field empty retains it; entering a value replaces it; removal is available when switching away from custom mode. Changing providers preserves the other provider's settings and ChatGPT connection. Stop active turns before changing settings or replacing a login.

Accounts apply to all projects owned by the signed-in Repellet user. Only the actual project owner can access agent controls, RPC, or events. Site-administrator privileges do not grant access to another owner's agent. Editors and viewers still see shared file changes through normal collaboration.

## Conversations

Agent and Preview share the resizable right panel, with Preview selected by default. Panel selection and selected conversation are saved locally per user/project using the existing workspace preferences format. Create, rename, fork, archive, and restore conversations in the Agent panel. ChatGPT model and effort choices come from Codex's model catalog; custom mode uses its configured model ID.

Send starts a turn. During generation, Steer adds guidance to the active turn; Stop interrupts it. One top-level turn can execute per project; different projects can execute concurrently. Questions appear inline and survive browser reconnects. Markdown, plans, collapsible command output, and editor-linked file diffs are rendered in the transcript; unfamiliar items appear as generic activity.

Browser saves and server-held collaborative documents are flushed before starting or steering work. Resolve disk conflicts first. Agent edits use the existing watchers and collaboration reconciliation. Commands, file writes, and network requests have full access inside the project's existing unprivileged Docker environment. The agent runs as a separate Linux user; it does not receive the bridge control token.

Executing turns keep their workspace awake without an open browser. A turn blocked on an owner question follows the normal idle timeout. Workspace stop, rebuild, deletion, maintenance, or disabling the owner account interrupts work. Reconnect restores current activity and unresolved questions. After a lost mutation response, Repellet reconciles status/history and never automatically retries the prompt. Worker restarts terminate stale agent processes and recover saved history without replaying work.

## Storage and operation

Project agent homes, Codex history, and SQLite state persist in `repellet-PROJECT_UUID-agent`, mounted at `/home/agent` with private permissions. Shared terminals cannot read this home. Project files use a shared group and default ACLs; a temporary filesystem helper prepares existing files before an agent starts. The project container retains its existing capability restrictions. Private agent bytes count toward project storage limits. Duplicating a project starts with fresh agent history; deleting it removes the agent volume.

Central user auth homes and personal provider settings persist in the worker's `repellet-agent-accounts` volume. Refresh tokens stay there. Project processes receive short-lived ChatGPT access tokens with ephemeral credential storage; simultaneous refresh requests are coalesced through the central auth server. Custom keys reach only the agent process environment, are excluded from tool subprocess environments, and are redacted from its returned errors/events. Project exports contain shared project files, not either private home.

Backup/restore includes agent and account volumes. Backup manifest version 1 remains compatible with older backups that have only workspace/home volumes. In local development, `AGENT_ACCOUNTS_HOME` can select a private directory; the default is `~/.repellet-agent-accounts`. Container deployments mount the persistent account volume automatically. Rebuild the app, worker, and workspace images when upgrading; the workspace base tag is `repellet/workspace-base:0.4.0`.

The shared `@repellet/codex-protocol` package includes experimental TypeScript bindings and JSON schemas generated from exactly `0.160.0`. Regenerate with `npm run generate -w @repellet/codex-protocol`; the script rejects other binary versions and normalizes type-only ESM imports. The pinned local server's paginated history store does not implement `list_turns`, so new conversations explicitly use Codex's durable `legacy` history contract.

The pinned server's legacy history API omits persisted tool calls. A version-specific, read-only adapter projects commands, patches, and other tool activity from Codex's own private rollout files. It accepts only the history path returned by Codex under the project's private sessions directories; browsers cannot choose a filesystem path. Codex owns and writes all durable history. Command timing and intermediate output are available while streaming; restored commands show their saved tool result.

Repellet remains a trusted, self-hosted integration. [OpenAI's app-server authentication guidance](https://developers.openai.com/codex/app-server#auth-endpoints) distinguishes local/open-source integrations from commercial hosted services; commercial hosting requires a separate Sign in with ChatGPT integration. Provider settings follow the [configuration reference](https://developers.openai.com/codex/config-reference). Upload attachments, scheduling, and dedicated subagent management are deferred.
