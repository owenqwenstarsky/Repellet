# Architecture

The TypeScript monorepo separates browser-facing authorization from Docker control.

| Component         | Responsibilities                                                                                                         | Access                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `apps/web`        | React/Vite dashboard, Monaco/Yjs editor, xterm, Git/settings/admin UI                                                    | Authenticated API and WebSockets                     |
| `apps/api`        | Fastify, Argon2 passwords, sessions, membership checks, PostgreSQL/Drizzle, durable Yjs state, lifecycle/idle monitoring | Database and internal worker token; no Docker socket |
| `apps/worker`     | Docker builds, container lifecycle, volume ownership, preview gateways, bridge relay                                     | Docker socket and internal authentication            |
| `packages/bridge` | Workspace files/watchers, shell PTYs, process groups, Git, formatters, LSP transport, storage measurement                | Runs as UID 1000 inside each project                 |
| `packages/shared` | Runtime catalog, schemas, types, limits, safe path validation                                                            | Shared contract                                      |

Compose creates a private control network and a workspace network. Only the application and allocated preview ports are published. Project containers receive no Docker socket, privileged mode, arbitrary host mounts, or installation encryption key. The worker is a highly privileged trusted component because it controls Docker.

## Storage and lifecycle

PostgreSQL stores installation configuration, users, hashed session tokens, projects, memberships, encrypted environment variables, build jobs, and collaborative documents. SQL migrations have checksums and run under a database advisory lock. Workspace volumes are named `repellet-PROJECT_UUID-files` and `repellet-PROJECT_UUID-home`. Containers and volumes carry project labels.

Runtime images combine pinned curated toolchains with a common Debian environment, Git/SSH/build utilities, and an isolated bridge Node runtime. Cache tags include the selected runtime Dockerfile and base image ID. `/workspace` and `/home/workspace` survive recreation. Runtime rebuilding stops the current container; its image/volumes remain until the replacement build succeeds. A failed build can be retried using the existing runtime selection. Dependencies built against an older runtime may require reinstalling.

Project lifecycle operations are serialized in both API and worker. The model includes stopped, building, starting, running, stopping, and failed. Startup reconciles recorded state with Docker, restores preview gateways/watchers, and marks interrupted jobs failed. The monitor checks container health and storage every 30 seconds.

## Collaboration and files

Each open text document has a Yjs document, awareness state, serialized update queue, disk hash, and dirty/conflict flags. Accepted updates are persisted before acknowledgement/broadcast. Debounced materialization uses atomic writes and compare-and-swap disk hashes. Run and Git operations flush pending document edits first. Server-stored dirty documents are recovered after restart.

Clean terminal/Git changes update open documents. If disk changes diverge while the document is dirty, autosave pauses for all clients until an editor chooses Reload from disk or Keep editor content. Structural changes block document joins, drain accepted changes, close document channels, perform the filesystem operation, and update durable paths. Independent IDE writes are serialized so competing requests cannot both accept the same disk revision. Terminal processes remain external writers; the conflict mechanism detects divergence, but the filesystem is not a transactional database.

Document reconnects resubmit unacknowledged Yjs updates for convergence. Terminal sessions retain bounded replay buffers and remain alive when browser tabs close. Terminal output and stdin are shared; viewers' input is blocked at the API regardless of browser state. Sessions and terminal replay buffers end when the container stops.

## Authentication and previews

Owner setup uses an encrypted random one-time token and a transactional singleton lock. There is no registration route. Argon2id password hashes and server-side sessions use HttpOnly, SameSite=Strict cookies (Secure when PUBLIC_URL is HTTPS). State-changing requests and IDE WebSockets require an exact allowed Origin. Account disabling, password reset, and membership changes revoke affected API sockets and authenticated preview sockets immediately.

Every preview uses a distinct port/origin. HTTP requests and WebSocket upgrades ask the API to validate the session and project membership. The gateway removes IDE session cookies and Authorization headers before proxying; preview response cookies cannot replace the reserved session cookie. Previews may frame only approved IDE origins. Cookies are host-scoped (browsers do not isolate cookies by port), so this gateway is essential. Operators must preserve the same hostname and TLS scheme across IDE and previews.

Environment variables use authenticated AES-256-GCM encryption. Only owners/site owner configure them, but editors with terminal access can read injected values. Losing the encryption key loses access to stored secrets and the setup token. Workspace code has normal outbound network access; trusted invitation and private network access are deployment assumptions.
