import type { Project, User } from '@repellet/shared';
export const user: User = {
  id: 'user',
  username: 'owen',
  displayName: 'Owen',
  enabled: true,
  isOwner: true,
  createdAt: '',
};
export const project: Project = {
  id: 'project',
  name: 'Project',
  description: '',
  ownerId: user.id,
  runtimes: ['node'],
  state: 'running',
  role: 'owner',
  runConfig: { command: 'npm run dev', cwd: '', port: 3000 },
  previewPort: null,
  storageBytes: 0,
  storageExceeded: false,
  error: null,
  createdAt: '',
  updatedAt: '',
};
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: any[] = [];
  onmessage?: (event: any) => any;
  onclose?: (event: any) => any;
  onerror?: (event: any) => any;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  message(value: unknown) {
    return this.onmessage?.({ data: JSON.stringify(value) });
  }
  disconnect(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  close() {
    this.disconnect(1000);
  }
}
