import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import * as schema from './schema.js';
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 12 });
export const db = drizzle(pool, { schema });
export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(724911)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS repellet_migrations (name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const file of (await fs.readdir(config.migrationDir))
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      const sql = await fs.readFile(path.join(config.migrationDir, file), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const found = await client.query('SELECT hash FROM repellet_migrations WHERE name=$1', [
        file,
      ]);
      if (found.rows[0]) {
        if (found.rows[0].hash !== hash) throw new Error(`Applied migration changed: ${file}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO repellet_migrations(name,hash) VALUES($1,$2)', [
          file,
          hash,
        ]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(724911)');
    client.release();
  }
}
