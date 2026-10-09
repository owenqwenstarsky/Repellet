# Bundled Pi extensions

Repellet loads only the two wrappers in this directory. Sources under `upstream/`
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
