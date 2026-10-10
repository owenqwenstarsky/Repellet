import { beforeEach, expect, it, vi } from 'vitest';
import { BSON } from '../packages/bridge/src/database-mongo.js';
const state = vi.hoisted(() => ({
  columns: [] as any[],
  rows: [] as any[],
  calls: [] as any[],
  cursorClosed: false,
  mongoFilter: null as any,
  mongoReplacement: null as any,
  mongoDocuments: [] as any[],
  commands: [] as any[],
  commandResults: [] as any[],
  failure: null as Error | null,
}));
vi.mock('pg-cursor', () => ({
  default: class {
    sql: string;
    parameters: unknown[];
    _result = { rowCount: 42 };
    constructor(sql: string, parameters: unknown[]) {
      this.sql = sql;
      this.parameters = parameters;
    }
    async read() {
      if (state.failure) throw state.failure;
      return state.rows.length ? [state.rows.shift()] : [];
    }
    async close() {
      state.cursorClosed = true;
    }
  },
}));
vi.mock('pg', () => ({
  default: {
    Client: class {
      constructor(options: any) {
        state.calls.push({ connection: options });
      }
      async connect() {}
      async end() {}
      query(sql: any, values?: any[]) {
        state.calls.push({
          sql: typeof sql === 'string' ? sql : sql.sql,
          values: values || sql.parameters,
        });
        if (typeof sql !== 'string') return sql;
        if (sql.includes('FROM pg_attribute')) return Promise.resolve({ rows: state.columns });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
    },
  },
}));
vi.mock('../packages/bridge/src/database-mongo.js', async (original) => {
  const actual = await original<any>();
  function cursor() {
    return {
      sort() {
        return this;
      },
      skip() {
        return this;
      },
      limit() {
        return this;
      },
      batchSize() {
        return this;
      },
      async close() {},
      async *[Symbol.asyncIterator]() {
        for (const doc of state.mongoDocuments) yield doc;
      },
    };
  }
  return {
    ...actual,
    MongoClient: class {
      async connect() {}
      async close() {}
      db(name: string) {
        expect(name).toBe('repellet');
        return {
          command: async (command: any) => {
            state.commands.push(command);
            return state.commandResults.shift() || { ok: 1 };
          },
          listCollections: cursor,
          collection: () => ({
            find: (filter: any) => {
              state.mongoFilter = filter;
              return cursor();
            },
            deleteOne: async (filter: any) => {
              state.mongoFilter = filter;
              return { deletedCount: 1 };
            },
            replaceOne: async (filter: any, value: any) => {
              state.mongoFilter = filter;
              state.mongoReplacement = value;
              return { modifiedCount: 1 };
            },
            insertOne: async () => ({}),
            drop: async () => {},
          }),
          createCollection: async () => {},
        };
      }
    },
  };
});
import { databaseOperation } from '../packages/bridge/src/database.js';
const id = '11111111-1111-4111-8111-111111111111';
const postgres = {
  id,
  type: 'postgresql' as const,
  url: `postgresql://workspace:password@repellet-database-${id}:5432/repellet`,
};
const mongo = {
  id,
  type: 'mongodb' as const,
  url: `mongodb://workspace:password@repellet-database-${id}:27017/repellet?authSource=repellet`,
};
beforeEach(() => {
  state.columns = [
    { name: 'id', type: 'bigint', primaryKey: true, nullable: false },
    { name: 'body', type: 'text', primaryKey: false, nullable: true },
  ];
  state.rows = [];
  state.calls = [];
  state.cursorClosed = false;
  state.mongoFilter = null;
  state.mongoReplacement = null;
  state.mongoDocuments = [];
  state.commands = [];
  state.commandResults = [];
  state.failure = null;
});
it('streams SQL results, caps record/byte counts, and closes the cursor', async () => {
  state.rows = Array.from({ length: 1005 }, (_, id) => ({ id }));
  expect(
    await databaseOperation(postgres, { operation: 'execute_sql', sql: 'SELECT * FROM users' }),
  ).toMatchObject({ rows: expect.any(Array), truncated: true, affected: 42 });
  expect(state.rows).toHaveLength(4);
  expect(state.cursorClosed).toBe(true);
  state.rows = [{ body: 'x'.repeat(1024 * 1024) }];
  expect(
    await databaseOperation(postgres, { operation: 'execute_sql', sql: 'SELECT body FROM users' }),
  ).toMatchObject({ rows: [], truncated: true });
});
it('parameterizes record edits and field-equality filters while quoting identifiers', async () => {
  await databaseOperation(postgres, {
    operation: 'update',
    name: 'users"',
    key: { id: '9007199254740993' },
    values: { body: "'; DROP TABLE users;--" },
  });
  expect(state.calls.at(-1)).toEqual({
    sql: 'UPDATE "public"."users""" SET "body"=$1 WHERE "id"=$2',
    values: ["'; DROP TABLE users;--", '9007199254740993'],
  });
  state.rows = [{ id: '1' }];
  await databaseOperation(postgres, {
    operation: 'read',
    name: 'users',
    filter: { body: 'secret' },
    offset: 100,
  });
  expect(state.calls.at(-1)).toMatchObject({
    sql: expect.stringContaining('"body" IS NOT DISTINCT FROM $1'),
    values: ['secret', 100],
  });
  state.columns = [{ name: 'body', type: 'text', nullable: true, primaryKey: false }];
  await expect(
    databaseOperation(postgres, { operation: 'delete', name: 'users', key: { body: 'x' } }),
  ).rejects.toThrow('primary key');
});
it('preserves BSON identity and uses literal equality for MongoDB read/delete selectors', async () => {
  const objectId = new BSON.ObjectId('0123456789abcdef01234567');
  state.mongoDocuments = [{ _id: objectId, created: new Date('2026-01-01T00:00:00Z') }];
  const result: any = await databaseOperation(mongo, {
    operation: 'read',
    name: 'users',
    filter: { _id: { $oid: objectId.toHexString() } },
  });
  expect(result.rows[0]).toEqual({
    _id: { $oid: objectId.toHexString() },
    created: { $date: { $numberLong: '1767225600000' } },
  });
  expect(state.mongoFilter._id.$eq).toEqual(objectId);
  await databaseOperation(mongo, {
    operation: 'delete',
    name: 'users',
    key: { _id: { $ne: null } },
  });
  expect(state.mongoFilter).toEqual({ _id: { $eq: { $ne: null } } });
  await expect(
    databaseOperation(mongo, { operation: 'read', name: 'users', filter: { $where: 'evil()' } }),
  ).rejects.toThrow('equality');
});
it('replaces documents so visual edits can remove fields without changing _id', async () => {
  await databaseOperation(mongo, {
    operation: 'update',
    name: 'users',
    key: { _id: 'one' },
    values: { name: 'new', _id: 'attempted-change' },
  });
  expect(state.mongoReplacement).toEqual({ name: 'new', _id: 'one' });
  expect(state.mongoFilter).toEqual({ _id: { $eq: 'one' } });
});
it('forces bounded MongoDB command batches and drains/kills cursors', async () => {
  state.commandResults = [
    { cursor: { id: BSON.Long.fromNumber(2), ns: 'repellet.users', firstBatch: [{ _id: 'one' }] } },
    { cursor: { id: BSON.Long.ZERO, nextBatch: [{ _id: 'two' }] } },
  ];
  const result: any = await databaseOperation(mongo, {
    operation: 'execute_mongo',
    command: { find: 'users', batchSize: 100000, limit: 100000, maxTimeMS: 100000 },
  });
  expect(result.rows).toEqual([{ _id: 'one' }, { _id: 'two' }]);
  expect(state.commands[0]).toMatchObject({ batchSize: 50, limit: 1001, maxTimeMS: 30000 });
  state.commandResults = [
    {
      cursor: {
        id: BSON.Long.fromNumber(3),
        ns: 'repellet.users',
        firstBatch: Array.from({ length: 1001 }, (_, id) => ({ id })),
      },
    },
  ];
  expect(
    await databaseOperation(mongo, { operation: 'execute_mongo', command: { find: 'users' } }),
  ).toMatchObject({ truncated: true });
  expect(state.commands.at(-1)).toMatchObject({ killCursors: 'users' });
});
it('rejects other connections/engines and marks failed writes uncertain without leaking credentials', async () => {
  await expect(
    databaseOperation(
      { ...postgres, url: 'postgresql://workspace:password@outside:5432/repellet' },
      { operation: 'read', name: 'users' },
    ),
  ).rejects.toThrow('managed database');
  await expect(
    databaseOperation(postgres, { operation: 'execute_mongo', command: { ping: 1 } }),
  ).rejects.toThrow('match database type');
  state.failure = new Error(`lost connection ${postgres.url}`);
  await expect(
    databaseOperation(postgres, {
      operation: 'execute_sql',
      sql: 'UPDATE users SET body=$1',
      parameters: ['secret'],
    }),
  ).rejects.toMatchObject({
    uncertain: true,
    statusCode: 503,
    message: 'Database write outcome is uncertain. Inspect current data before retrying.',
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    databaseOperation(postgres, { operation: 'read', name: 'users' }, controller.signal),
  ).rejects.toThrow();
});
