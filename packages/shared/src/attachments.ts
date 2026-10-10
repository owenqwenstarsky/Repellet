import { z } from 'zod';

export const MAX_AGENT_IMAGES = 4;
export const MAX_AGENT_TEXT_FILES = 4;
export const MAX_AGENT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_AGENT_TEXT_BYTES = 1024 * 1024;
export const agentImageMimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const agentAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['image', 'text']),
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((name) => !/[\x00-\x1f\x7f/\\]/.test(name)),
    mimeType: z.string().min(1).max(100),
    bytes: z.number().int().positive().max(MAX_AGENT_IMAGE_BYTES),
    label: z.literal('Pasted text').optional(),
  })
  .strict();
export type AgentAttachment = z.infer<typeof agentAttachmentSchema>;

export const agentAttachmentUploadSchema = agentAttachmentSchema.omit({
  id: true,
  bytes: true,
  kind: true,
});
export function agentAttachmentKind(mimeType: string, name: string): 'image' | 'text' | null {
  if ((agentImageMimeTypes as readonly string[]).includes(mimeType)) return 'image';
  if (mimeType.startsWith('image/')) return null;
  if (
    /^text\/[a-z0-9.+-]+$/i.test(mimeType) ||
    ['application/json', 'application/xml', 'application/csv', 'application/x-ndjson'].includes(
      mimeType,
    ) ||
    ((!mimeType || mimeType === 'application/octet-stream') &&
      /\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml)$/i.test(name))
  )
    return 'text';
  return null;
}
export function agentAttachmentUrl(projectId: string, attachmentId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/agent/attachments/${encodeURIComponent(attachmentId)}`;
}
