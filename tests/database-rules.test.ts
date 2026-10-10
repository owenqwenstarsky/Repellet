import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import {
  environmentOperationSchema,
  databaseOperationSchema,
  parseResourceControlRequest,
} from '@repellet/shared';
import {
  applyEnvironmentOperation,
  assertManagedVariable,
} from '../apps/api/src/environment-rules.js';
import {
  identifier,
  requirePrimaryKey,
  columnDefinition,
  boundDatabaseResult,
} from '../packages/bridge/src/database.js';
import { isBackupVolume, stopProjectDatabases } from '../scripts/lib/backup.mjs';
const h = createRequire(import.meta.url)('../docker/pi-session.cjs');

it('protects the connection variable while allowing a collision-free rename', () => {
  const current = { DATABASE_URL: 'managed', TOKEN: 'secret' };
  for (const operation of [
    { operation: 'delete', name: 'DATABASE_URL' },
    { operation: 'update', name: 'DATABASE_URL', value: 'other' },
  ])
    expect(() =>
      applyEnvironmentOperation(
        current,
        environmentOperationSchema.parse(operation),
        'DATABASE_URL',
      ),
    ).toThrow('managed');
  const next = applyEnvironmentOperation(
    current,
    { operation: 'rename', name: 'DATABASE_URL', newName: 'DB' },
    'DATABASE_URL',
  );
  expect(next).toEqual({ DB: 'managed', TOKEN: 'secret' });
  expect(() => assertManagedVariable(current, next, 'DATABASE_URL', 'DB')).not.toThrow();
  for (const invalid of [
    { TOKEN: 'secret' },
    { DATABASE_URL: 'other' },
    { DATABASE_URL: 'managed', DB: 'managed' },
  ])
    expect(() =>
      assertManagedVariable(
        current,
        invalid,
        'DATABASE_URL',
        Object.hasOwn(invalid, 'DB') ? 'DB' : undefined,
      ),
    ).toThrow();
  expect(() =>
    applyEnvironmentOperation(
      current,
      { operation: 'rename', name: 'DATABASE_URL', newName: 'TOKEN' },
      'DATABASE_URL',
    ),
  ).toThrow('already exists');
});
it('rejects reserved variables and distinguishes create/update/delete semantics', () => {
  expect(() =>
    applyEnvironmentOperation({}, { operation: 'create', name: 'PATH', value: 'x' }),
  ).toThrow();
  expect(() =>
    applyEnvironmentOperation({ A: 'x' }, { operation: 'create', name: 'A', value: 'y' }),
  ).toThrow('already exists');
  expect(() =>
    applyEnvironmentOperation({}, { operation: 'update', name: 'A', value: 'y' }),
  ).toThrow('does not exist');
  expect(applyEnvironmentOperation({ A: 'x' }, { operation: 'delete', name: 'A' })).toEqual({});
});
it('quotes SQL identifiers and refuses incomplete or extra primary-key selectors', () => {
  expect(identifier('users"; DROP TABLE users;--')).toBe('"users""; DROP TABLE users;--"');
  expect(() => identifier('é'.repeat(32))).toThrow('identifier');
  expect(() => identifier('a\0b')).toThrow('identifier');
  const columns = [
    { name: 'tenant', type: 'text', primaryKey: true, nullable: false },
    { name: 'id', type: 'bigint', primaryKey: true, nullable: false },
  ];
  expect(requirePrimaryKey(columns, { tenant: 'one', id: '9007199254740993' })).toEqual([
    'tenant',
    'id',
  ]);
  for (const key of [{ id: 1 }, { tenant: null, id: 1 }, { tenant: 'one', id: 1, extra: 2 }])
    expect(() => requirePrimaryKey(columns, key)).toThrow('complete primary key');
  expect(() => requirePrimaryKey([], { id: 1 })).toThrow();
  expect(columnDefinition('body', 'jsonb', true)).toBe('"body" jsonb');
  expect(() => columnDefinition('body', 'text; DROP TABLE x', true)).toThrow('Unsupported');
});
it('bounds database payloads and validates narrow inspection contracts', () => {
  expect(boundDatabaseResult({ rows: [{ body: 'x'.repeat(1024 * 1024) }] })).toMatchObject({
    truncated: true,
  });
  expect(databaseOperationSchema.parse({ operation: 'read', name: 'users' })).toMatchObject({
    offset: 0,
  });
  expect(() =>
    parseResourceControlRequest({
      threadId: 't',
      turnId: 'u',
      operation: 'database_read',
      arguments: { name: 'users', sql: 'DELETE FROM users' },
    }),
  ).toThrow();
  expect(() =>
    parseResourceControlRequest({
      threadId: 't',
      turnId: 'u',
      operation: 'database_execute',
      arguments: { command: {}, url: 'other' },
    }),
  ).toThrow();
});
it('refreshes subsequent agent subprocess environments without preserving deleted names', () => {
  const environment = {
    PATH: '/bin',
    HOME: '/home/agent',
    OLD: 'old',
    REMOVED: 'secret',
    PROVIDER: 'private',
  };
  const tracked = h.replaceProjectEnvironment(environment, ['OLD', 'REMOVED'], {
    NEW: 'new',
    DATABASE_URL: 'db',
    HOME: 'bad',
    BRIDGE_TOKEN: 'bad',
    REPELLET_TOKEN: 'bad',
  });
  expect(environment).toEqual({
    PATH: '/bin',
    HOME: '/home/agent',
    PROVIDER: 'private',
    NEW: 'new',
    DATABASE_URL: 'db',
  });
  expect(h.replaceProjectEnvironment(environment, tracked, { DB: 'db' })).toEqual(['DB']);
  expect(environment).not.toHaveProperty('DATABASE_URL');
});
it('includes database volumes while accepting old names and quiesces before archive/restore', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  for (const kind of ['files', 'home', 'agent', 'attachments', 'database'])
    expect(isBackupVolume(`repellet-${id}-${kind}`)).toBe(true);
  expect(isBackupVolume('repellet-agent-accounts')).toBe(true);
  expect(isBackupVolume(`repellet-${id}-unknown`)).toBe(false);
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return args[0] === 'ps' ? 'container' : '';
  };
  await stopProjectDatabases([id], run);
  expect(calls[1]).toEqual(['stop', '--time', '20', 'container']);
  await stopProjectDatabases([id], run, true);
  expect(calls[3]).toEqual(['rm', '-f', 'container']);
  await expect(stopProjectDatabases(['../bad'], run)).rejects.toThrow('Invalid stored');
});
