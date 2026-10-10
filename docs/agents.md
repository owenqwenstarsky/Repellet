# Repellet agents

Pi 1.1.0 runs in every workspace image. Repellet supervises a private `pi-host` process that owns Pi SDK traffic, durable JSONL sessions, tool execution, and model streaming. The web app sees only Repellet's provider-neutral agent protocol. Pi does not provide Codex's built-in sub-agent controls. Repellet bundles the web-search, plan-mode, and main Run app extensions described below.

## Accounts and providers

**Sign in with ChatGPT** keeps the existing Plus/Pro device-code flow, polling, cancellation, reconnect, logout, and account-wide credential storage. Disconnecting ChatGPT interrupts agent work across your projects.

**Custom API** requires an HTTP(S) Responses API base URL and API key; model IDs are selected from the discovered catalog. Embedded credentials, query strings, and fragments are rejected. Reasoning effort is optional. The key stays in private worker settings and agent-host memory, is never written to `/workspace`, and is removed from tool subprocess environments.

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

Shared workspace permissions are prepared once before the workspace bridge starts. A versioned marker in the private agent home survives container recreation, so later workspace and agent starts avoid recursive permission scans and the resulting file-watcher traffic. The first start after upgrading may take longer while existing files are migrated. Stop and start an already-running workspace to apply this migration; agent restarts continue to refresh managed instructions without scanning project files.

Every project agent home receives Repellet's managed global context at `/home/agent/.pi/agent/SYSTEM.md` and `/home/agent/.pi/agent/AGENTS.md`. It stays outside `/workspace`, is refreshed at every agent start, and is advisory. Put project-specific instructions in the project's own `AGENTS.md`.

Central account homes and provider settings persist in the worker's `repellet-agent-accounts` volume. Refresh credentials stay there. Custom keys reach only the Pi host and are redacted from returned errors/events. Backups include agent and account volumes.

## Bundled extensions

Repellet pins [openai-websearch-pi](https://github.com/owenqwenstarsky/openai-websearch-pi) and [pi-plan](https://github.com/owenqwenstarsky/pi-plan) at the revisions recorded in `docker/pi-extensions/upstream/sources.json`. These trusted wrappers and Repellet's first-party `project.ts` extension load; workspace-installed extensions remain disabled.

`web_search` uses refreshed account credentials when signed in with ChatGPT. With a custom CLIProxyAPI provider, it uses that provider's base URL, private runtime key, and selected model through the Responses WebSocket endpoint. CLIProxyAPI must support Responses WebSockets and hosted web search. Search sends only the query, preserves source URLs, supports interruption, and does not create a proxy credential file or export its key to tools. `local_time` is also available.

The **Plan mode** button sits in the composer beside Run settings. It runs the extension's `/plan` command without starting a model turn. Plan mode disables write/edit tools and restricts bash to conservative read-only commands. State follows each conversation, including forks and agent restarts. Turn off Plan mode to restore normal tools; the button is disabled while work or a question is active.

Planning questions appear in the browser. A completed plan appears in the transcript and pauses for **Implement the plan**, **Make changes**. Implementation restores write tools and queues the extension's implementation prompt. Make changes reveals an empty feedback field in the review form. Unanswered questions do not expire. The transcript keeps one current plan with compact progress entries. Interrupting a review clears the pending question and retains plan mode.

The workspace base is now `repellet/workspace-base:0.7.1`. Stop and start older workspaces, or rebuild their environment, to receive the main Run app tools and updated bridge. Stopping only the app does not update a workspace. Existing project files and canonical session histories remain in their volumes. The Agent APIs feature requires no database migration; project databases use the normal application migrations.

## Main Run app tools

`project_status` reports the current workspace, live main Run process state, configured command, preparation blockers, and preview readiness. A running process can have a failed or unavailable preview. `starting` indicates an unresolved start; `unknown` indicates a failed status check. Neither is permission to spawn a duplicate app.

`project_logs` returns a snapshot of live main Run output, without attaching an interactive terminal. It defaults to the newest 200 lines, accepts 1–1,000 lines, strips terminal control sequences, and bounds combined output to 64 KiB. A stopped or exited app returns **not running** without historical output. The terminal UI continues to retain its own replay output.

`project_start` starts the configured default Run app and preserves an already running app. `project_stop` stops only the main Run app. Both preserve the workspace, agent connection, and other processes; they share the operation lock used by the UI. Start flushes saved documents and checks preparation, storage, and workspace compatibility. It does not install dependencies or start the workspace. The existing Run button keeps its restart behavior.

The system prompt and managed global instructions require `project_status` before every start or stop, and again between stop and start during a restart. The backend independently checks fresh state, without requiring a previous status-call receipt. Normal task authorization applies; ambiguous intent or project-specific approval requirements prompt an owner question. Plan mode exposes status and logs while hiding and blocking mutations, including restored and forked plans.

Managed instructions allow startup verification for app-affecting changes when the owner requests or explicitly authorizes runtime checks; a code-change request alone does not authorize starting or stopping the app. When authorized and safe, the agent uses project tools, inspects logs, and confirms the process stays running and HTTP preview status reaches `available` where applicable. The agent fixes failures caused by its changes within the authorized task and reports failures or owner-action blockers accurately. It leaves the app running for review unless the owner asks otherwise. Planning, read-only work, and documentation-only edits are exempt; project-specific approvals and browser verification limits still apply. Updated instructions require an updated workspace image and are copied into managed context at agent startup.

Tool requests travel through the Pi event bus, host JSONL connection, and worker to a worker-authenticated internal API. The worker binds requests to the current project, enabled owner, and active turn; tool parameters cannot select other projects, commands, or process IDs. Control-plane credentials stay outside the agent. Requests cancel with the turn and never automatically retry a start or stop after an uncertain response. Check status again before deciding what to do next.

## Global CLIProxyAPI and API selection

Administration → **Agent APIs** controls an optional server-wide CLIProxyAPI connection. Enter a Responses API base URL (including its API path) and a key, load the model catalog, select allowed IDs, and save. Loading a draft does not change the active connection. Blank key input retains the saved key; disable the connection before removing it. New catalog IDs are never automatically allowed, and an empty selection permits no proxy models. Missing selected IDs remain visible to administrators but cannot execute until they reappear in the catalog.

While enabled, the global connection overrides and hides personal proxy configuration. Existing personal credentials remain in private account storage and become available again when the global connection is disabled. ChatGPT sign-in is independent of the selected API. **Agent settings** saves a default API and separate model/effort preferences for each API. Personal proxy models are discovered rather than entered manually. **Run settings** selects ChatGPT Auth or CLIProxyAPI (Custom API for a personal connection) for subsequent turns without changing account defaults. Conversations restore their last-used API, model, and effort. Invalid saved selections require a new selection; the worker never silently switches APIs.

The worker fetches `/models` using the private connection key, preserves API path prefixes, caches successful catalogs for five minutes, and retains the last successful snapshot after refresh failures. Global configuration and its catalog live in the existing `repellet-agent-accounts` volume and are included in existing backups. No database migration is required; legacy settings are adapted on read and rewritten in the versioned format on save. Keys remain private worker settings and host memory, outside conversation files, tool environments, and browser responses.

The worker enforces the current effective connection and allowed model catalog for turns and compaction. Administrator changes let admitted turns finish, then refresh affected hosts before further model execution. API/model/effort changes are disabled during turns and compaction, and web search follows the active provider and model.

The workspace base is `repellet/workspace-base:0.7.1`. Stop and start existing workspaces, or rebuild their environments, to receive the updated host. Older adapters are rejected with upgrade guidance before model execution. Files and canonical session history remain in their volumes. Verification for this change uses mocked in-memory storage, provider requests, authentication, Pi sessions, and React rendering; it does not start containers, browsers, databases, or external services.

## Database and environment tools

Workspaces using base image `repellet/workspace-base:0.7.0` include database inspection/execution and saved environment-variable management tools. Owners create/delete databases in the closable Database tab; agents operate an existing PostgreSQL or MongoDB development database. Plan mode exposes inspection and variable list/get while hiding and blocking writes. Agent shell tools refresh saved project variables before each launch, including after a rename or deletion. See [development databases](databases.md) for operations, limits, and upgrade details.
