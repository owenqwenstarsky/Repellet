import { useEffect, useRef, useState } from 'react';
import { X, FileText } from 'lucide-react';
import {
  agentAttachmentKind,
  agentImageMimeTypes,
  MAX_AGENT_IMAGES,
  MAX_AGENT_TEXT_FILES,
  MAX_AGENT_IMAGE_BYTES,
  MAX_AGENT_TEXT_BYTES,
  type AgentAttachment,
} from '@repellet/shared';
import { uploadAgentAttachment, errorMessage } from './api';
import { Button, IconButton } from './ui';

export const attachmentAccept = [
  ...agentImageMimeTypes,
  'text/*',
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.csv',
  '.tsv',
  '.log',
  '.xml',
].join(',');
type DraftAttachment = {
  key: number;
  file: File;
  kind: 'image' | 'text';
  mimeType: string;
  label?: 'Pasted text';
  preview?: string;
  progress: number;
  attachment?: AgentAttachment;
  error?: string;
  controller: AbortController;
};
export function useAgentAttachments(projectId: string, threadId: string) {
  const drafts = useRef(new Map<string, DraftAttachment[]>());
  const draftKey = (id: string) => `${projectId}:${id}`;
  const nextId = useRef(0);
  const alive = useRef(true);
  const [, render] = useState(0);
  const update = () => {
    if (alive.current) render((value) => value + 1);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const entries of drafts.current.values())
        for (const entry of entries) {
          entry.controller.abort();
          if (entry.preview) URL.revokeObjectURL(entry.preview);
        }
      drafts.current.clear();
    };
  }, [projectId]);
  async function upload(entry: DraftAttachment) {
    entry.error = undefined;
    entry.progress = 0;
    entry.controller = new AbortController();
    update();
    try {
      entry.attachment = await uploadAgentAttachment(
        projectId,
        entry.file,
        entry.mimeType,
        entry.label,
        (percent) => {
          entry.progress = percent;
          update();
        },
        entry.controller.signal,
      );
    } catch (error) {
      if (!entry.controller.signal.aborted) entry.error = errorMessage(error);
    }
    update();
  }
  function add(files: File[], report: (message: string) => void, label?: 'Pasted text') {
    const entries = drafts.current.get(draftKey(threadId)) || [];
    const added: DraftAttachment[] = [];
    for (const file of files) {
      const mimeType = file.type || 'application/octet-stream';
      const kind = agentAttachmentKind(mimeType, file.name);
      const limit = kind === 'image' ? MAX_AGENT_IMAGES : MAX_AGENT_TEXT_FILES;
      if (!kind) {
        report(`${file.name}: choose a PNG, JPEG, WebP, GIF, or text file.`);
        continue;
      }
      if (
        !file.size ||
        file.size > (kind === 'image' ? MAX_AGENT_IMAGE_BYTES : MAX_AGENT_TEXT_BYTES)
      ) {
        report(
          `${file.name}: ${kind === 'image' ? 'images must be 1 byte–20 MiB' : 'text files must be 1 byte–1 MiB'}.`,
        );
        continue;
      }
      if ([...entries, ...added].filter((entry) => entry.kind === kind).length >= limit) {
        report(
          `Attach at most ${limit} ${kind === 'image' ? 'images' : 'text files'} per message.`,
        );
        continue;
      }
      added.push({
        key: ++nextId.current,
        file,
        kind,
        mimeType,
        label,
        progress: 0,
        ...(kind === 'image' ? { preview: URL.createObjectURL(file) } : {}),
        controller: new AbortController(),
      });
    }
    drafts.current.set(draftKey(threadId), [...entries, ...added]);
    update();
    for (const entry of added) void upload(entry);
    return added.length > 0;
  }
  function remove(key: number, id = threadId) {
    const entries = drafts.current.get(draftKey(id)) || [];
    const entry = entries.find((entry) => entry.key === key);
    entry?.controller.abort();
    if (entry?.preview) URL.revokeObjectURL(entry.preview);
    drafts.current.set(
      draftKey(id),
      entries.filter((entry) => entry.key !== key),
    );
    update();
  }
  const entries = drafts.current.get(draftKey(threadId)) || [];
  return {
    entries,
    add,
    remove,
    retry: upload,
    blocked: entries.some((entry) => !entry.attachment),
    input: entries
      .filter((entry) => entry.attachment)
      .map((entry) => ({
        type: 'attachment' as const,
        attachmentId: entry.attachment!.id,
        kind: entry.kind,
      })),
    clear: (id: string) => {
      for (const entry of drafts.current.get(draftKey(id)) || []) remove(entry.key, id);
      drafts.current.delete(draftKey(id));
    },
  };
}

export function AgentDraftAttachments({
  entries,
  disabled,
  onRemove,
  onRetry,
}: {
  entries: DraftAttachment[];
  disabled: boolean;
  onRemove: (key: number) => void;
  onRetry: (entry: DraftAttachment) => void;
}) {
  if (!entries.length) return null;
  return (
    <div className="agent-draft-attachments" aria-label="Message attachments">
      {entries.map((entry) => (
        <div className={`agent-draft-attachment ${entry.kind}`} key={entry.key}>
          {entry.preview ? (
            <img src={entry.preview} alt={entry.file.name} />
          ) : (
            <FileText size={14} aria-hidden="true" />
          )}
          <span title={entry.file.name}>{entry.label || entry.file.name}</span>
          {!entry.attachment && !entry.error && (
            <progress
              aria-label={`Uploading ${entry.file.name}`}
              value={entry.progress}
              max={100}
            />
          )}
          {entry.error && (
            <>
              <span className="agent-attachment-error" role="alert">
                {entry.error}
              </span>
              <Button size="sm" disabled={disabled} onClick={() => onRetry(entry)}>
                Retry
              </Button>
            </>
          )}
          <IconButton
            label={`Remove ${entry.label || entry.file.name}`}
            icon={<X size={12} />}
            disabled={disabled}
            onClick={() => onRemove(entry.key)}
          />
        </div>
      ))}
    </div>
  );
}
