import type {
  DocumentIdentity,
  RunProfile,
  WorkspaceEvent,
  WorkspaceProcess,
} from '@repellet/shared';
export type WorkspaceSnapshot = {
  version: 1;
  projectId: string;
  cursor: number;
  documents: DocumentIdentity[];
  runProfiles: RunProfile[];
  processes: WorkspaceProcess[];
};
/** The event cursor advances only after the consumer applies the event. */
export class WorkspaceSession {
  cursor: number | undefined;
  documents = new Map<string, DocumentIdentity>();
  constructor(readonly projectId: string) {}
  accept(event: WorkspaceEvent, apply: (event: WorkspaceEvent) => void) {
    if (event.projectId !== this.projectId || event.version !== 1) return 'resync' as const;
    if (this.cursor !== undefined && event.seq <= this.cursor) return 'duplicate' as const;
    if (this.cursor === undefined || event.seq !== this.cursor + 1) return 'resync' as const;
    apply(event);
    this.cursor = event.seq;
    return 'applied' as const;
  }
  reconcileDocuments(next: DocumentIdentity[], remap: (from: string, to?: string) => void) {
    const registry = new Map(next.map((doc) => [doc.id, doc]));
    for (const [id, previous] of this.documents) {
      const current = registry.get(id);
      if (!current) remap(previous.path);
      else if (previous.path !== current.path) remap(previous.path, current.path);
    }
    this.documents = registry;
  }
}
