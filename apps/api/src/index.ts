import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { defaultLimits } from '@repellet/shared';
import { db, migrate, pool } from './db.js';
import { installation, users } from './schema.js';
import { encrypt, decrypt } from './security.js';
import { config } from './config.js';
import { createApp } from './app.js';
import { reconcile, monitor } from './lifecycle.js';
await migrate();
await db
  .insert(installation)
  .values({
    id: 1,
    setupToken: encrypt(randomBytes(24).toString('base64url')),
    limits: defaultLimits,
  })
  .onConflictDoNothing();
const app = await createApp();
const [owner] = await db.select().from(users).where(eq(users.isOwner, true));
if (!owner) {
  const [install] = await db.select().from(installation).where(eq(installation.id, 1));
  if (install?.setupToken) app.log.info(`First-time setup token: ${decrypt(install.setupToken)}`);
}
await app.listen({ host: config.host, port: config.port });
void reconcile().catch((e) => app.log.error(e));
const timer = setInterval(() => {
  void monitor().catch((e) => app.log.error(e));
}, 30000);
timer.unref();
async function shutdown() {
  clearInterval(timer);
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
