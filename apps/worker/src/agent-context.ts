export const managedAgentContextSource = '/opt/repellet/agent-context/AGENTS.md';
export const managedAgentContextTarget = '/home/agent/.codex/AGENTS.md';

/** Refreshes the managed global instructions without touching other Codex state. */
export const installManagedAgentContext = `mkdir -p /home/agent/.codex && chown 1001:1001 /home/agent /home/agent/.codex && chmod 700 /home/agent /home/agent/.codex && install -o 1001 -g 1001 -m 0444 ${managedAgentContextSource} ${managedAgentContextTarget}`;
