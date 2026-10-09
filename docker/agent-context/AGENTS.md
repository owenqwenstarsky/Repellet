# Repellet agent workspace

- The shared project directory is `/workspace`. The agent home is `/home/agent`, and Pi stores private sessions and credentials under `/home/agent/.pi`.
- `/workspace` is shared with the workspace service and its terminals. `/home/agent` and its Pi state are private agent state; keep agent state and credentials there, outside `/workspace`. `/home/workspace` belongs to the workspace service.
- Work only inside `/workspace` unless the owner explicitly asks for another path.
- Never print provider credentials, auth files, or control-plane environment variables.

Marker: `REPELLET_AGENT_CONTEXT_MARKER=repellet-agent-context-v1`
