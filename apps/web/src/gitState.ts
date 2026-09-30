import type { GitStatus } from '@repellet/shared';
type Entry = GitStatus['entries'][number];
export const isConflicted = (entry: Entry) =>
  ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(entry.index + entry.worktree);
export function gitGroups(entries: Entry[]) {
  return [
    { title: 'CONFLICTS', staged: false, conflict: true, entries: entries.filter(isConflicted) },
    {
      title: 'STAGED',
      staged: true,
      conflict: false,
      entries: entries.filter((e) => !isConflicted(e) && ![' ', '?'].includes(e.index)),
    },
    {
      title: 'UNSTAGED / UNTRACKED',
      staged: false,
      conflict: false,
      entries: entries.filter((e) => !isConflicted(e) && e.worktree !== ' '),
    },
  ];
}
