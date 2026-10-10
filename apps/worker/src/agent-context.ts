export const managedAgentContextSource = '/opt/repellet/agent-context/AGENTS.md';
export const managedAgentContextTarget = '/home/agent/.pi/agent/SYSTEM.md';
export const managedGlobalAgentContextTarget = '/home/agent/.pi/agent/AGENTS.md';
/** Refreshes the managed global instructions without touching Pi sessions or credentials. */
export const installManagedAgentContext = `mkdir -p /home/agent/.pi/agent && chown 1001:1001 /home/agent /home/agent/.pi /home/agent/.pi/agent && chmod 700 /home/agent /home/agent/.pi /home/agent/.pi/agent && install -o 1001 -g 1001 -m 0444 ${managedAgentContextSource} ${managedAgentContextTarget} && install -o 1001 -g 1001 -m 0444 ${managedAgentContextSource} ${managedGlobalAgentContextTarget}`;
