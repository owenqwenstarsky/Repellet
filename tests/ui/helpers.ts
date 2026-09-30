import type { Project, User, GitHubRepository, SetupSuggestion } from '@repellet/shared';
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const user: User = {
  id: 'user',
  username: 'owen',
  displayName: 'Owen',
  isOwner: true,
  enabled: true,
  createdAt: '',
};
export const project: Project = {
  id: 'project',
  name: 'Test project',
  description: 'Original',
  ownerId: user.id,
  runtimes: ['node'],
  state: 'running',
  role: 'owner',
  starterId: null,
  starterVersion: null,
  setupCommand: '',
  preparation: { status: 'none', error: null },
  appStatus: { status: 'stopped', generation: 0 },
  repository: null,
  runConfig: { command: 'npm run dev', cwd: '', port: 3000 },
  previewPort: null,
  storageBytes: 0,
  storageExceeded: false,
  error: null,
  createdAt: '',
  updatedAt: '',
} as Project;
export const repos: GitHubRepository[] = [
  { id: 1, fullName: 'owen/one', cloneUrl: '', installationId: 10, canPush: true },
  { id: 2, fullName: 'owen/two', cloneUrl: '', installationId: 10, canPush: true },
];
export const suggestion: SetupSuggestion = {
  runtimes: ['python'],
  setupCommand: 'pip install -r requirements.txt',
  runConfig: { command: 'python app.py', cwd: 'server', port: 8000 },
  warnings: [],
};
