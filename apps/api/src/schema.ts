import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
  bigint,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import type {
  Runtime,
  Limits,
  ProjectState,
  ProjectRole,
  Preparation,
  AppStatus,
  GitHubSource,
  WorkflowStep,
} from '@repellet/shared';
export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  username: text().notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isOwner: boolean('is_owner').notNull().default(false),
  enabled: boolean().notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);
export const installation = pgTable('installation', {
  id: integer().primaryKey(),
  setupToken: text('setup_token'),
  limits: jsonb().$type<Limits>().notNull(),
  maintenance: boolean().notNull().default(false),
});
export const projects = pgTable(
  'projects',
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    description: text().notNull().default(''),
    runtimes: jsonb().$type<Runtime[]>().notNull(),
    state: text().$type<ProjectState>().notNull().default('stopped'),
    runConfig: jsonb('run_config')
      .$type<{ command: string; cwd: string; port: number }>()
      .notNull(),
    environment: text(),
    cloneUrl: text('clone_url'),
    starterId: text('starter_id'),
    starterVersion: integer('starter_version'),
    setupCommand: text('setup_command').notNull().default(''),
    preparation: jsonb()
      .$type<Preparation>()
      .notNull()
      .default({ status: 'none', scaffolded: false, fingerprint: null, error: null }),
    appStatus: jsonb('app_status').$type<AppStatus>().notNull().default({ status: 'stopped' }),
    repository: jsonb().$type<GitHubSource>(),
    previewPort: integer('preview_port'),
    storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull().default(0),
    storageExceeded: boolean('storage_exceeded').notNull().default(false),
    error: text(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('projects_owner_idx').on(t.ownerId)],
);
export const members = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text().$type<Exclude<ProjectRole, 'owner'>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);
export const documents = pgTable(
  'documents',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text().notNull(),
    state: text().notNull(),
    diskHash: text('disk_hash'),
    dirty: boolean().notNull().default(false),
    conflict: boolean().notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('documents_project_idx').on(t.projectId)],
);
export const jobs = pgTable('jobs', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  kind: text().notNull(),
  state: text().notNull().default('pending'),
  error: text(),
  step: text(),
  steps: jsonb().$type<WorkflowStep[]>().notNull().default([]),
  log: text().notNull().default(''),
  startedAt: timestamp('started_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const githubConfig = pgTable('github_config', {
  id: integer().primaryKey(),
  encrypted: text().notNull(),
});
export const githubConnections = pgTable('github_connections', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  encrypted: text().notNull(),
  login: text().notNull(),
  githubId: bigint('github_id', { mode: 'number' }).notNull(),
  installationId: bigint('installation_id', { mode: 'number' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revoked: boolean().notNull().default(false),
});
export const githubStates = pgTable('github_states', {
  hash: text().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
