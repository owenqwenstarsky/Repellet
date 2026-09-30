import { config } from './config.js';
export async function workerRequest(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(config.workerUrl + route, {
    method,
    headers: {
      authorization: `Bearer ${config.workerToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(
      route.endsWith('/ensure') || route.endsWith('/build') ? 30 * 60 * 1000 : 180000,
    ),
  });
  if (!response.ok) {
    let message = await response.text();
    let completedFiles: string[] | undefined;
    try {
      const details = JSON.parse(message);
      message = details.error || message;
      if (Array.isArray(details.completedFiles)) completedFiles = details.completedFiles;
    } catch {}
    throw Object.assign(new Error(message), { statusCode: response.status, completedFiles });
  }
  return response;
}
export async function workerJson<T = any>(
  route: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  return (await workerRequest(route, method, body)).json() as Promise<T>;
}
export async function bridge<T = any>(
  id: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  return workerJson(`/projects/${id}/request`, 'POST', { path, method, body });
}
