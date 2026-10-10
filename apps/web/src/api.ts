import type { AgentAttachment } from '@repellet/shared';
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public completedFiles?: string[],
  ) {
    super(message);
  }
}

function idempotencyKey() {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === 'function') return source.randomUUID();

  // randomUUID is only exposed in secure browser contexts. getRandomValues
  // remains available on HTTP dev URLs, including a direct Tailscale URL.
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === 'function') source.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api' + path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(['POST', 'PUT', 'DELETE'].includes(options.method || '') &&
      /^\/projects\/[0-9a-f-]+(?:\/(?:open|stop|duplicate|environment|database(?:\/retry)?))?$/.test(
        path,
      )
        ? { 'idempotency-key': idempotencyKey() }
        : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    let message = response.statusText;
    let completedFiles: string[] | undefined;
    try {
      const details = await response.json();
      message = details.error || message;
      completedFiles = details.completedFiles;
    } catch {}
    if (response.status === 401 && response.headers?.get('x-repellet-auth') === 'session')
      window.dispatchEvent(new Event('repellet:unauthorized'));
    throw new ApiError(message, response.status, completedFiles);
  }
  return response.json();
}
export const post = <T = any>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const put = <T = any>(path: string, body: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const patch = <T = any>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const remove = (path: string) => api(path, { method: 'DELETE' });
export const wsUrl = (path: string) =>
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
export function uploadAgentAttachment(
  projectId: string,
  file: File,
  mimeType: string,
  label: 'Pasted text' | undefined,
  progress: (percent: number) => void,
  signal: AbortSignal,
): Promise<AgentAttachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ name: file.name, mimeType, ...(label ? { label } : {}) });
    const abort = () => xhr.abort();
    const finish = () => signal.removeEventListener('abort', abort);
    xhr.open('POST', `/api/projects/${encodeURIComponent(projectId)}/agent/attachments?${query}`);
    xhr.timeout = 180000;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      finish();
      let body: any;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body);
      else {
        if (xhr.status === 401 && xhr.getResponseHeader('x-repellet-auth') === 'session')
          window.dispatchEvent(new Event('repellet:unauthorized'));
        reject(
          new ApiError(body?.error || xhr.statusText || 'Attachment upload failed', xhr.status),
        );
      }
    };
    xhr.onerror = () => {
      finish();
      reject(new Error('Attachment upload failed. Retry when connected.'));
    };
    xhr.ontimeout = () => {
      finish();
      reject(new Error('Attachment upload timed out. Retry when connected.'));
    };
    xhr.onabort = () => {
      finish();
      reject(new Error('Attachment upload cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      finish();
      reject(new Error('Attachment upload cancelled'));
    } else xhr.send(file);
  });
}
export const previewUrl = (port: number) =>
  `${location.protocol}//${location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname}:${port}`;
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
