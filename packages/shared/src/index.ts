import { z } from 'zod';
export const runtimeCatalog = [
  {
    id: 'python',
    name: 'Python',
    version: '3.13.12',
    tools: 'Pip · Pyright',
    image: 'python:3.13.12-slim-bookworm',
    extensions: ['py'],
  },
  {
    id: 'node',
    name: 'Node.js',
    version: '24.14.0',
    tools: 'NPM · TypeScript',
    image: 'node:24.14.0-bookworm-slim',
    extensions: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'],
  },
  {
    id: 'go',
    name: 'Go',
    version: '1.26.1',
    tools: 'Go modules · gopls',
    image: 'golang:1.26.1-bookworm',
    extensions: ['go'],
  },
  {
    id: 'rust',
    name: 'Rust',
    version: '1.95.0',
    tools: 'Cargo · rust-analyzer',
    image: 'rust:1.95.0-slim-bookworm',
    extensions: ['rs'],
  },
] as const;
export const runtimeSchema = z.enum(['python', 'node', 'go', 'rust']);
export type Runtime = z.infer<typeof runtimeSchema>;
export const runtimesSchema = z
  .array(runtimeSchema)
  .min(1)
  .max(4)
  .refine((v) => new Set(v).size === v.length, 'Select each runtime once');
export const limitsSchema = z.object({
  cpu: z.number().min(0.25).max(64),
  memoryMb: z.number().int().min(256).max(131072),
  storageMb: z.number().int().min(128).max(1048576),
  maxActiveProjects: z.number().int().min(1).max(100),
  idleMinutes: z.number().int().min(1).max(1440),
});
export type Limits = z.infer<typeof limitsSchema>;
export const defaultLimits: Limits = {
  cpu: 2,
  memoryMb: 2048,
  storageMb: 5120,
  maxActiveProjects: 3,
  idleMinutes: 30,
};
export const credentialsSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(12).max(128),
});
export const userCreateSchema = credentialsSchema.extend({
  displayName: z.string().trim().min(1).max(80),
});
export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
  runtimes: runtimesSchema,
  cloneUrl: z
    .string()
    .max(2048)
    .optional()
    .refine(
      (v) => !v || /^https:\/\/[^\s]+$/.test(v) || /^git@[a-zA-Z0-9.-]+:[^\s]+$/.test(v),
      'Use an HTTPS or git@ SSH URL',
    ),
});
export const runConfigSchema = z.object({
  command: z.string().max(4096),
  cwd: z.string().max(1024).default(''),
  port: z.number().int().min(1024).max(65535),
});
export const environmentSchema = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .refine(
        (v) =>
          ![
            'BRIDGE_TOKEN',
            'NODE_OPTIONS',
            'LD_PRELOAD',
            'LD_LIBRARY_PATH',
            'PATH',
            'HOME',
          ].includes(v),
        'Reserved variable',
      ),
    z.string().max(32768),
  )
  .refine((v) => Object.keys(v).length <= 100, 'At most 100 variables');
export type ProjectState = 'stopped' | 'building' | 'starting' | 'running' | 'stopping' | 'failed';
export type ProjectRole = 'owner' | 'editor' | 'viewer';
export type User = {
  id: string;
  username: string;
  displayName: string;
  isOwner: boolean;
  enabled: boolean;
  createdAt: string;
};
export type Project = {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  runtimes: Runtime[];
  state: ProjectState;
  role: ProjectRole;
  runConfig: { command: string; cwd: string; port: number };
  previewPort: number | null;
  storageBytes: number;
  storageExceeded: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  ownerName?: string;
  running?: boolean;
};
export type FileEntry = {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  size: number;
};
export type FileContent = {
  path: string;
  content: string;
  hash: string | null;
  binary?: boolean;
  size: number;
};
export type TerminalInfo = { id: string; name: string; alive: boolean; isRun: boolean };
export type GitStatus = {
  branch: string;
  entries: { path: string; index: string; worktree: string }[];
  initialized: boolean;
};
export type SearchMatch = { path: string; line: number; text: string };
export function safeRelativePath(value: string): string {
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.split('/').some((p) => p === '..')
  )
    throw new Error('Path must stay within the workspace');
  return value
    .split('/')
    .filter((p) => p && p !== '.')
    .join('/');
}
