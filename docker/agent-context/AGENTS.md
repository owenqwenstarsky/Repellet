# Repellet agent workspace

- The shared project directory is `/workspace`. The agent home is `/home/agent`, and Pi stores private sessions and credentials under `/home/agent/.pi`.
- `/workspace` is shared with the workspace service and its terminals. `/home/agent` and its Pi state are private agent state; keep agent state and credentials there, outside `/workspace`. `/home/workspace` belongs to the workspace service.
- Work only inside `/workspace` unless the owner explicitly asks for another path.
- Never print provider credentials, auth files, or control-plane environment variables.

## Verification limits

- You have no browser access or visual verification capability. Only applicable integration tests are available for verifying changes.
- Do not plan or attempt browser checks, screenshots, responsive-layout verification, or other testing beyond integration tests.
- When the codebase consists only of plain HTML, CSS, and JavaScript files, changes require no tests. Complete these tasks without adding verification steps.
- Do not leave tasks incomplete because unavailable checks cannot run, or routinely report the lack of browser verification.

Marker: `REPELLET_AGENT_CONTEXT_MARKER=repellet-agent-context-v1`
