# Bundled Pi extensions

Repellet loads the `websearch.ts` and `plan.ts` wrappers and the first-party
`project.ts` extension in this directory. Sources under `upstream/`
are pinned, verbatim snapshots of Owen's requested repositories; `sources.json`
records their exact revisions. Update those snapshots deliberately, rather than
fetching mutable branches when a workspace starts.

`websearch.ts` resolves ChatGPT auth with Pi's model registry and custom proxy
auth from the host's runtime key. CLIProxyAPI uses the upstream Responses
WebSocket transport. No extra login, credential file, or tool environment key
is required.

`plan.ts` retains the upstream `/plan` command, tool filtering, shell guards,
and branch-local plan/todo state. Its browser adapter replaces terminal
questions and review dialogs with Repellet's owner-only question channel.
Review choices are recorded on the session branch. Selecting "Implement the
plan" supplies explicit implementation approval to subsequent model turns;
entering plan mode again or changing the plan clears that approval.

`project.ts` provides `project_status`, `project_logs`, `project_start`, and
`project_stop` for the current project's main Run app. Requests travel through
the Pi host and worker to Repellet's authenticated control plane; the extension
receives no control-plane credentials. Start preserves an already running app.
Plan mode permits status and logs while blocking start and stop. Logs are bounded
live snapshots; stopped processes have no tool-visible history. Existing
workspaces require a normal rebuild to receive the updated host and bridge.
