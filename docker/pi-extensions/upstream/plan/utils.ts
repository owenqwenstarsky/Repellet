/** State stored in the session so plan mode follows session branches. */
export interface PlanModeState {
	enabled: boolean;
	toolsBeforePlanMode?: string[];
}

// A command must match a read-only command family and must not contain a
// destructive token. This is intentionally conservative: users can leave plan
// mode when they need a command that is not obviously read-only.
const SAFE_COMMANDS = [
	/^(?:command\s+)?(?:cat|head|tail|less|more|grep|rg|find|fd|ls|eza|tree|pwd|wc|sort|uniq|diff|file|stat|du|df|which|whereis|type|env|printenv|uname|whoami|id|date|cal|uptime|ps|top|htop|free|jq|bat)\b/i,
	/^git\s+(?:status|log|diff|show|branch|remote|ls-files|ls-tree|rev-parse|describe|tag\s+--list)\b/i,
	/^(?:npm|yarn|pnpm)\s+(?:list|ls|view|info|why|outdated|audit)\b/i,
	/^(?:node|python|python3)\s+--version\b/i,
	/^curl\s+(?:--head|-I|--silent\s+--head|-s\s+--head)\b/i,
	/^wget\s+(?:--spider|--output-document=-|-O\s*-|--quiet\s+--spider)\b/i,
	/^sed\s+-n\b/i,
	/^awk\b/i,
];

const DESTRUCTIVE_TOKENS = [
	/\b(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred)\b/i,
	/\b(?:npm|yarn|pnpm)\s+(?:install|add|remove|uninstall|update|ci|link|publish)\b/i,
	/\b(?:pip|pip3|apt|apt-get|brew)\s+(?:install|uninstall|remove|purge|update|upgrade)\b/i,
	/\bgit\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|init|clone)\b/i,
	/\b(?:sudo|su|kill|pkill|killall|reboot|shutdown)\b/i,
];

export function isSafeReadOnlyCommand(command: string): boolean {
	const trimmed = command.trim();
	// Do not permit shell composition. A command that starts with `cat` must
	// not be able to run an arbitrary second command after a pipe or semicolon.
	if (!trimmed || /[;&|<>`$\n\r]/.test(trimmed)) return false;
	if (/\b(?:find\s+.*-(?:exec|execdir|delete)|system\s*\(|(?:node|python3?|perl)\s+-e)\b/i.test(trimmed)) return false;
	if (DESTRUCTIVE_TOKENS.some((pattern) => pattern.test(trimmed))) return false;
	return SAFE_COMMANDS.some((pattern) => pattern.test(trimmed));
}
