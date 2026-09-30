import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
export const config = {
  databaseUrl: process.env.DATABASE_URL || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  workerToken: process.env.WORKER_TOKEN || '',
  workerUrl: process.env.WORKER_URL || 'http://worker:3002',
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  webDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
  migrationDir: fileURLToPath(new URL('../migrations', import.meta.url)),
};
if (!config.databaseUrl) throw new Error('Set DATABASE_URL');
if (!/^[a-f0-9]{64}$/i.test(config.encryptionKey))
  throw new Error('ENCRYPTION_KEY must be a 32-byte hexadecimal value. Run npm run setup.');
if (config.workerToken.length < 32)
  throw new Error('WORKER_TOKEN must have at least 32 characters');
export const allowedOrigins = new Set([
  new URL(config.publicUrl).origin,
  ...(process.env.ADDITIONAL_ORIGINS || '').split(',').filter(Boolean),
]);
