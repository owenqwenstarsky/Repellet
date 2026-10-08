# Repellet agent context

This is stable, managed context supplied by Repellet. It is advisory and does not override the user's request, project instructions, or other applicable instructions.

- The agent runs in a Debian container. The workspace user is UID/GID `1000:1000`; the agent account is UID/GID `1001:1001`, and agent processes run as `1001:1000` to share project files.
- The shared project directory is `/workspace`. The agent home is `/home/agent`, and `CODEX_HOME` is `/home/agent/.codex`.
- `/workspace` is shared with the workspace service and its terminals. `/home/agent` and its Codex history are private agent state; keep agent state and credentials there, outside `/workspace`. `/home/workspace` belongs to the workspace service.
- Network access is available from the project container as configured at runtime. The container has no Docker socket, Docker daemon, or Repellet control-plane access. Full-access sandbox behavior is limited to this container and its mounted filesystems.
- Credentials may be supplied to the agent process through environment variables, including the custom provider key in `REPELLET_AGENT_API_KEY`; it is excluded from tool subprocess environments. Never print environment variables, command environments, credential values, or files that may contain them. Check only whether a required value is present, and keep secrets out of `/workspace`, logs, patches, and responses.
- CPU, memory, process, storage, runtime, and network limits are dynamic. Check them instead of guessing: `nproc`, `free -h`, `df -h /workspace /home/agent`, `du -sh /workspace /home/agent`, `ulimit -a`, and `cat /proc/self/limits`.
- Cgroup limits under `/sys/fs/cgroup` describe container constraints; `free` and `df` may show host capacity rather than project limits. Repellet's project storage limit also counts private agent state.
- Use `/workspace` for project files and normal shell tools for runtime inspection. Do not assume a particular language runtime, package cache, network route, or amount of capacity is available until you verify it.

Marker: `REPELLET_AGENT_CONTEXT_MARKER=repellet-agent-context-v1`
