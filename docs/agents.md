# Repellet agents

Pi 1.1.0 runs in every workspace image. Repellet supervises a private `pi-host` process that owns Pi SDK traffic, durable JSONL sessions, tool execution, and model streaming. The web app sees only Repellet's provider-neutral agent protocol. Pi does not provide Codex's built-in sub-agent controls. Repellet bundles the web-search and plan-mode extensions described below.

## Accounts and providers

**Sign in with ChatGPT** keeps the existing Plus/Pro device-code flow, polling, cancellation, reconnect, logout, and account-wide credential storage. Disconnecting ChatGPT interrupts agent work across your projects.

**Custom API** requires an HTTP(S) Responses API base URL, API key, and model ID. Embedded credentials, query strings, and fragments are rejected. Reasoning effort is optional. The key stays in private worker settings and agent-host memory, is never written to `/workspace`, and is removed from tool subprocess environments.

Accounts apply to all projects owned by the signed-in Repellet user. Only the actual project owner can access agent controls, RPC, or events. Editors and viewers still see shared file changes through normal collaboration.

## Sessions and migration

Pi session files under `/home/agent/.pi/sessions` are canonical conversation history. A small private index stores thread ID, display name, archived state, timestamps, session file, and provider/model metadata for fast list and archived filtering. Fork, rename, archive, unarchive, steering, interruption, and model selection use Repellet's adapter operations.

The one-time importer reads existing Codex JSONL histories into Pi sessions, shows imported and skipped conversation names and counts in Agent settings, and never modifies the original files, including after successful import. Provider credentials and private session paths are never returned to browsers.

## Workspace behavior

Agent and Preview share the resizable right panel. The Agent tab opens to a searchable Threads page; selecting a row opens a thread detail view with a sticky composer, grouped transcript activity, run settings, and explicit ready/working/waiting/disconnected status. Cmd/Ctrl+Enter submits while Enter remains available for multiline input.

Browser saves and collaborative documents flush before starting or steering work. One top-level turn executes per project; different projects can execute concurrently. Questions survive reconnects. Workspace stop, rebuild, deletion, maintenance, or disabling the owner account interrupts work. A lost mutation response reconciles status/history without replaying the prompt.

The composer accepts files through **Attach files**, drag-and-drop, and clipboard paste. Each message can include four images (PNG, JPEG, WebP, GIF; up to 20 MiB each) and four UTF-8 text files (up to 1 MiB each). Text MIME types and common `.txt`, `.md`, `.json`, `.csv`, `.log`, and `.xml` files are supported. Pasting 1,000–5,000 characters offers inline text or a file; more than 5,000 characters becomes a **Pasted text** attachment automatically. Attachments have removable previews, upload progress, and retry controls. They work for both new turns and steering.

Images and text files persist in `repellet-PROJECT_UUID-attachments`, mounted privately at `/home/agent/attachments`. UUID references and filenames remain in saved user messages, while Pi receives image content and labeled text-file content. Downloads are owner-only, including when a project is stopped. Attachments count toward monitored project storage, are included in backups, and are removed with the project. Removed draft uploads remain stored until project deletion; project duplication copies files without private history or attachments.

Project agent homes persist in `repellet-PROJECT_UUID-agent`, mounted at `/home/agent` with private permissions. Shared terminals cannot read this home. Project files use a shared group and ACLs; private agent bytes count toward project storage limits.

Every project agent home receives Repellet's managed global context at `/home/agent/.pi/agent/SYSTEM.md`. It stays outside `/workspace`, is refreshed at every agent start, and is advisory. Put project-specific instructions in the project's own `AGENTS.md`.

Central account homes and provider settings persist in the worker's `repellet-agent-accounts` volume. Refresh credentials stay there. Custom keys reach only the Pi host and are redacted from returned errors/events. Backups include agent and account volumes.

## Bundled extensions

Repellet pins [openai-websearch-pi](https://github.com/owenqwenstarsky/openai-websearch-pi) and [pi-plan](https://github.com/owenqwenstarsky/pi-plan) at the revisions recorded in `docker/pi-extensions/upstream/sources.json`. Only these trusted extensions load; workspace-installed extensions remain disabled.

`web_search` uses refreshed account credentials when signed in with ChatGPT. With a custom CLIProxyAPI provider, it uses that provider's base URL, private runtime key, and selected model through the Responses WebSocket endpoint. CLIProxyAPI must support Responses WebSockets and hosted web search. Search sends only the query, preserves source URLs, supports interruption, and does not create a proxy credential file or export its key to tools. `local_time` is also available.

The **Plan mode** button sits in the composer beside Run settings. It runs the extension's `/plan` command without starting a model turn. Plan mode disables write/edit tools and restricts bash to conservative read-only commands. State follows each conversation, including forks and agent restarts. Turn off Plan mode to restore normal tools; the button is disabled while work or a question is active.

Planning questions appear in the browser. A completed plan appears in the transcript and pauses for **Implement the plan**, **Make changes**, or **Keep planning**. Implementation restores write tools and queues the extension's implementation prompt. Changes collect feedback before the extension revises the plan. Interrupting a review clears the pending question and retains plan mode.

The workspace base is now `repellet/workspace-base:0.6.2`. Stop and start older workspaces to receive attachment support and the bundled extensions. Existing project files and canonical session histories remain in their volumes.
