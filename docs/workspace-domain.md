# Workspace domain implementation

This change implements the first workspace-domain migration and independently managed run profiles. It is a foundation for the private IDE roadmap, not the completed eight-phase release.

## Available behavior

- Workspace protocol version 1 defines event envelopes, actor metadata, profiles, processes, preview targets, document identities, and project-agent policies in `packages/shared/src/workspace.ts`.
- PostgreSQL persists a project-local event cursor and the most recent 2,000 events. `/ws/projects/:id/events?protocol=1&cursor=N` replays events before accepting live delivery. Omit `cursor` for initial snapshot refresh. Expired and future cursors receive `resync-required`; legacy clients without a protocol parameter retain the existing event payloads. The browser deduplicates sequences, detects gaps, and refreshes project, terminal, file-tree, and document-registry state on reconnect.
- Events are appended before delivery to versioned clients. The API serializes replay and subscription with publication on this single-host installation. Slow clients disconnect and replay. Heartbeats expire disconnected presence, and multiple tabs are deduplicated by user.
- Documents keep their existing UUID and Yjs snapshot. A revision increments with each persisted document state transition and rename. Document sync and acknowledgement responses expose the identity and revision. Registry snapshots and live metadata reconcile renamed open tabs after reconnects.
- Installation administrators no longer inherit project permissions. Explicit ownership or membership is required for content, environment, terminals, Git, previews, and workspace metadata. The administrative inventory exposes operational fields, membership-aware Open controls, and an independent Stop endpoint.
- Owners manage profiles from **Project settings → Run profiles**. Editors can start and stop profile processes; viewers can observe. Each profile has a command, working directory, selected environment variable names, and optional automatic start. Run and Task launches use distinct stable process IDs. A repeated start while the profile is active returns its existing process.
- The original Run configuration is preserved as the default Run profile and App preview target. A database trigger maintains compatibility with existing creation, duplication, preparation, and settings APIs. The legacy Run toolbar remains available. The default profile inherits the project's environment for compatibility; other profiles receive only selected project variables.
- Profile execution checks the bridge protocol/capabilities, flushes collaborative documents, enforces preparation/storage checks, and records lifecycle metadata. Output replay remains bounded to 1 MiB per terminal; at most 50 exited terminal sessions are retained in the bridge and 200 historical process records in PostgreSQL. Container replacement marks missing processes as failed. Workspace stop and restore mark active process records stopped. Unknown start outcomes are reconciled before another process is launched.
- Viewer terminal input is rejected by both API and bridge. The first connected editor controls terminal size; control passes to the next editor when it disconnects.
- Lifecycle HTTP calls accept `Idempotency-Key` for open, stop, duplicate, environment rebuild, and deletion. Keys are scoped to the signed-in user and hashed request. Completed receipts are replayed; changed requests or pending/unknown outcomes return 409. Keys are retained for at least 24 hours and pruned during new lifecycle requests. Never blindly retry an unknown outcome with a new key.
- Workspace mutation audit rows contain actor, route, result, and request ID; request bodies and query strings are excluded. Event and activity retention is bounded. Fastify responses include `x-request-id`.

## Upgrade and recovery

Migrations are forward-only, additive SQL files with recorded checksums. Never edit an applied migration. Back up the database, volumes, and installation encryption key before upgrading. Migration `0005_workspace.sql` backfills default profiles/preview metadata and adds event, activity, process, idempotency, and reserved shared-agent tables without rewriting Yjs state or copying personal agent histories.

The workspace base image is now `repellet/workspace-base:0.5.2`. Stop/start or rebuild an existing workspace to install the new bridge. New process APIs return an explicit rebuild message when an old bridge lacks the required capability. The main Run button and default profile share a managed process. Terminal close removes the session; stopping a managed process retains output. Older bridges retain stopped shells internally, which the API omits from the session list until the bridge is upgraded.

The normal full PostgreSQL backup includes all new tables, cursor/compaction state, and profiles. Restoring clears process execution state and allocated preview ports; it does not restart commands. Older backups remain accepted and acquire the additive tables when the application migrates them. Automatic profiles run on workspace startup, not during API restart reconciliation.

This implementation assumes one API instance owns workspace event delivery and operation queues. It does not introduce distributed locks or cross-host event fan-out. Metadata writes and event writes are separate transactions; reconnect snapshot reconciliation is still necessary after abrupt termination between them. A transactional outbox is required before claiming lossless lifecycle-event acceptance across every crash boundary.

## Remaining roadmap work

- Shared-agent policy tables and wire contracts are reserved only. Owner-only personal agent behavior remains in effect. There is no shared credential administration or shared transcript execution path yet; no personal state is migrated into shared tables.
- Preview-target metadata is backfilled, but multiple listeners, allocation/readiness APIs, per-target controls, and profile-triggered readiness are not implemented. The existing authenticated single preview stays in operation.
- The workspace client session currently owns replay cursors and document identities, not all editor/terminal/agent/presence state. Existing fallback polling remains.
- Split editor groups, command palette, symbol actions/background diagnostics, paged trees, richer presence/activity UI, terminal actor labels, and full terminal/run bookkeeping migration remain outstanding.
- Full security review, comprehensive audit semantics, request quotas, operational metrics, feature-flag rollout, load testing, expanded backup/restore acceptance, and native Linux AMD64/ARM64 validation remain release work.

Continue to treat this as trusted, self-hosted development for invitees. Docker is not a hostile-code SaaS sandbox.

## Run settings

Project settings has one Run page. Saving updates the run command, optional install command,
folder, preview port, and default-profile automatic start without executing commands. Changing
the install command or folder marks preparation `required`; opening the project does not install
until an editor requests preparation. Run-only and port-only edits preserve successful preparation.
A port change stops a running workspace; the user starts it again explicitly.

Additional commands retain their profile IDs and preview associations. Advanced environment
selection passes only the named saved project variables; an empty selection passes none.
