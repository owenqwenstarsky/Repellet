import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
export const config = {
  token: process.env.WORKER_TOKEN || '',
  port: Number(process.env.WORKER_PORT || 3002),
  network: process.env.DOCKER_NETWORK || 'repellet-workspaces',
  inDocker: process.env.WORKER_IN_DOCKER === 'true',
  context: process.env.WORKSPACE_CONTEXT || fileURLToPath(new URL('../../../', import.meta.url)),
  appUrl: process.env.INTERNAL_APP_URL || 'http://app:3000',
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',
  portRange: (process.env.PREVIEW_PORT_RANGE || '41000-41031').split('-').map(Number),
};
if (config.token.length < 32)
  throw new Error('Set WORKER_TOKEN to a random value of at least 32 characters');
export function authorized(header: string | undefined) {
  const a = Buffer.from(header?.replace(/^Bearer /, '') || ''),
    b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const bridgeToken = (id: string) =>
  createHmac('sha256', config.token).update(`bridge:${id}`).digest('hex');
export function projectId(input: string) {
  if (!/^[0-9a-f-]{36}$/.test(input))
    throw Object.assign(new Error('Invalid project ID'), { statusCode: 400 });
  return input;
}
