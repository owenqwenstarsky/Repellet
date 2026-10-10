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
  uniqueIndex,
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
    environmentRevision: integer('environment_revision').notNull().default(0),
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
    revision: bigint({ mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('documents_project_idx').on(t.projectId)],
);
export const workspaceStreams = pgTable('workspace_streams', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  seq: bigint({ mode: 'number' }).notNull().default(0),
  retainedAfter: bigint('retained_after', { mode: 'number' }).notNull().default(0),
});
export const workspaceEvents = pgTable(
  'workspace_events',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    seq: bigint({ mode: 'number' }).notNull(),
    version: integer().notNull().default(1),
    type: text().notNull(),
    actor: jsonb().$type<{ id: string; name: string; role: ProjectRole }>(),
    payload: jsonb().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.seq] })],
);
export const workspaceActivity = pgTable(
  'workspace_activity',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    actor: jsonb().$type<{ id: string; name: string; role: ProjectRole }>(),
    action: text().notNull(),
    metadata: jsonb().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('workspace_activity_project_idx').on(t.projectId, t.createdAt)],
);
export const projectPreviewTargets = pgTable(
  'project_preview_targets',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    targetPort: integer('target_port').notNull(),
    allocatedPort: integer('allocated_port'),
    status: text().notNull().default('stopped'),
    httpStatus: integer('http_status'),
    lastProbe: timestamp('last_probe', { withTimezone: true }),
    generation: bigint({ mode: 'number' }).notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [uniqueIndex('project_preview_name_idx').on(t.projectId, t.name)],
);
export const projectRunProfiles = pgTable(
  'project_run_profiles',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    command: text().notNull(),
    cwd: text().notNull().default(''),
    environmentKeys: jsonb('environment_keys').$type<string[]>().notNull().default([]),
    previewTargetId: uuid('preview_target_id').references(() => projectPreviewTargets.id, {
      onDelete: 'set null',
    }),
    autoStart: boolean('auto_start').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [uniqueIndex('project_run_profile_name_idx').on(t.projectId, t.name)],
);
export const workspaceProcesses = pgTable(
  'workspace_processes',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => projectRunProfiles.id, { onDelete: 'set null' }),
    kind: text().notNull(),
    status: text().notNull(),
    pid: integer(),
    exitCode: integer('exit_code'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('workspace_processes_project_idx').on(t.projectId, t.createdAt)],
);
export const projectAgentPolicies = pgTable('project_agent_policies', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  enabled: boolean().notNull().default(false),
  provider: text().$type<'custom'>().notNull().default('custom'),
  model: text().notNull().default(''),
  reasoningEffort: text('reasoning_effort'),
  encryptedCredential: text('encrypted_credential'),
  baseUrl: text('base_url'),
  editorsCanExecute: boolean('editors_can_execute').notNull().default(true),
  viewersCanObserve: boolean('viewers_can_observe').notNull().default(true),
  credentialVersion: integer('credential_version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const projectAgentThreads = pgTable(
  'project_agent_threads',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.threadId] })],
);
export const workspaceIdempotency = pgTable(
  'workspace_idempotency',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    requestHash: text('request_hash').notNull(),
    state: text().notNull(),
    statusCode: integer('status_code'),
    response: jsonb(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
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

export const projectDatabases = pgTable('project_databases', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  id: uuid().notNull().unique(),
  type: text().$type<import('@repellet/shared').DatabaseType>().notNull(),
  image: text().notNull(),
  credentials: text().notNull(),
  initialized: boolean().notNull().default(false),
  variableName: text('variable_name').notNull().default('DATABASE_URL'),
  status: text()
    .$type<import('@repellet/shared').DatabaseStatus['status']>()
    .notNull()
    .default('creating'),
  error: text(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
