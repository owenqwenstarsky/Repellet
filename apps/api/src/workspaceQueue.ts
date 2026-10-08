/** Single-host workspace ownership. Separate queues avoid lifecycle/event deadlocks. */
export class WorkspaceQueue {
  private readonly pending = new Map<string, Promise<unknown>>();
  has(projectId: string) {
    return this.pending.has(projectId);
  }
  async run<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(projectId) || Promise.resolve()).catch(() => {}).then(operation);
    this.pending.set(projectId, next);
    try {
      return await next;
    } finally {
      if (this.pending.get(projectId) === next) this.pending.delete(projectId);
    }
  }
  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending.values()]);
  }
}
