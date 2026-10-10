import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import { z } from 'zod';
import {
  agentAttachmentKind,
  agentAttachmentSchema,
  agentAttachmentUploadSchema,
  MAX_AGENT_IMAGE_BYTES,
  MAX_AGENT_TEXT_BYTES,
  type AgentAttachment,
} from '@repellet/shared';
import { docker, BASE_IMAGE } from '../images.js';
import { volumeName } from '../workspaces.js';

export const attachmentDirectory = '/home/agent/attachments';
const error = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });

export function validateAttachment(input: unknown, data: Buffer) {
  const meta = agentAttachmentUploadSchema.parse(input);
  const kind = agentAttachmentKind(meta.mimeType, meta.name);
  if (!kind || (meta.label && kind !== 'text')) throw error('Unsupported attachment type');
  if (!data.length) throw error('Attachments cannot be empty');
  if (data.length > (kind === 'image' ? MAX_AGENT_IMAGE_BYTES : MAX_AGENT_TEXT_BYTES))
    throw error(
      kind === 'image' ? 'Images are limited to 20 MiB' : 'Text files are limited to 1 MiB',
      413,
    );
  if (kind === 'image') {
    const detected =
      data.length >= 33 &&
      data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : data.length >= 4 &&
            data[0] === 255 &&
            data[1] === 216 &&
            data[2] === 255 &&
            data[data.length - 2] === 255 &&
            data[data.length - 1] === 217
          ? 'image/jpeg'
          : data.length >= 16 &&
              data.toString('ascii', 0, 4) === 'RIFF' &&
              data.toString('ascii', 8, 12) === 'WEBP' &&
              data.readUInt32LE(4) + 8 === data.length
            ? 'image/webp'
            : data.length >= 14 &&
                /^(GIF87a|GIF89a)$/.test(data.toString('ascii', 0, 6)) &&
                data[data.length - 1] === 59
              ? 'image/gif'
              : null;
    if (detected !== meta.mimeType) throw error('Image contents do not match the declared type');
  } else {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw Error();
    } catch {
      throw error('Text attachments must contain UTF-8 text');
    }
  }
  return { ...meta, kind, mimeType: kind === 'text' ? 'text/plain' : meta.mimeType };
}

async function withVolume<T>(
  projectId: string,
  operation: (helper: Awaited<ReturnType<typeof docker.createContainer>>) => Promise<T>,
) {
  const helper = await docker.createContainer({
    Image: BASE_IMAGE,
    Cmd: ['true'],
    User: '1001:1000',
    HostConfig: {
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      Mounts: [{ Type: 'volume', Source: volumeName(projectId, 'attachments'), Target: '/data' }],
    },
    Labels: { 'repellet.helper': 'true' },
  });
  try {
    return await operation(helper);
  } finally {
    await helper.remove({ force: true });
  }
}

/** Read only the requested regular file; never extract archive paths to the host filesystem. */
async function archiveFile(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const extract = tar.extract();
  return new Promise((resolve, reject) => {
    let result: Buffer | undefined;
    const fail = (e: Error) => {
      extract.destroy(e);
      (stream as Readable).destroy(e);
      reject(e);
    };
    stream.on('error', reject);
    extract.on('error', reject);
    extract.on('entry', (header, entry, next) => {
      if (result || header.type !== 'file' || !header.size || header.size > maxBytes) {
        entry.resume();
        fail(error('Invalid attachment archive'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      entry.on('data', (value) => {
        const chunk = Buffer.from(value as Uint8Array);
        bytes += chunk.length;
        if (bytes > maxBytes) fail(error('Oversized attachment archive'));
        else chunks.push(chunk);
      });
      entry.on('error', reject);
      entry.on('end', () => {
        result = Buffer.concat(chunks);
        next();
      });
    });
    extract.on('finish', () =>
      result ? resolve(result) : reject(error('Attachment not found', 404)),
    );
    stream.pipe(extract);
  });
}

export async function storeAttachment(
  projectId: string,
  input: unknown,
  data: Buffer,
): Promise<AgentAttachment> {
  const validated = validateAttachment(input, data);
  const meta = agentAttachmentSchema.parse({ ...validated, id: randomUUID(), bytes: data.length });
  await withVolume(projectId, async (helper) => {
    const pack = tar.pack();
    pack.entry({ name: meta.id + '/', type: 'directory', mode: 0o700, uid: 1001, gid: 1000 });
    pack.entry(
      { name: meta.id + '/metadata.json', mode: 0o600, uid: 1001, gid: 1000 },
      JSON.stringify(meta),
    );
    pack.entry({ name: meta.id + '/data', mode: 0o600, uid: 1001, gid: 1000 }, data);
    pack.finalize();
    await helper.putArchive(Readable.from(pack), { path: '/data', noOverwriteDirNonDir: true });
  });
  return meta;
}

export async function readAttachment(projectId: string, attachmentId: string, includeData = false) {
  const id = z.string().uuid().parse(attachmentId);
  return withVolume(projectId, async (helper) => {
    try {
      const meta = agentAttachmentSchema.parse(
        JSON.parse(
          (
            await archiveFile(await helper.getArchive({ path: `/data/${id}/metadata.json` }), 4096)
          ).toString('utf8'),
        ),
      );
      if (meta.id !== id) throw error('Invalid attachment metadata');
      const data = includeData
        ? await archiveFile(
            await helper.getArchive({ path: `/data/${id}/data` }),
            meta.kind === 'image' ? MAX_AGENT_IMAGE_BYTES : MAX_AGENT_TEXT_BYTES,
          )
        : undefined;
      if (data && data.length !== meta.bytes) throw error('Attachment is incomplete');
      return { meta, data };
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404)
        throw error('Attachment not found in this project', 404);
      throw e;
    }
  });
}

export async function resolveAttachmentInputs(projectId: string, input: Record<string, any>[]) {
  const resolved = [];
  for (const item of input) {
    if (item.type !== 'attachment') {
      resolved.push(item);
      continue;
    }
    const { meta } = await readAttachment(projectId, item.attachmentId);
    if (item.kind !== meta.kind) throw error('Attachment type does not match');
    resolved.push({ type: 'attachment', attachment: meta });
  }
  return resolved;
}
