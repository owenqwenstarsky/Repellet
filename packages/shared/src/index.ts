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
export const starterCatalog = [
  {
    id: 'static-html',
    version: 1,
    name: 'HTML / CSS / JavaScript',
    runtimes: ['node'] as Runtime[],
    setupCommand: '',
    runConfig: {
      command: '/opt/repellet/node/bin/node /opt/repellet/bridge/dist/static-server.js --port 3000',
      cwd: '',
      port: 3000,
    },
    initialFile: 'index.html',
  },
  {
    id: 'react-vite',
    version: 1,
    name: 'React / Vite / TypeScript',
    runtimes: ['node'] as Runtime[],
    setupCommand: 'npm ci',
    runConfig: { command: 'npm run dev', cwd: '', port: 3000 },
    initialFile: 'src/App.tsx',
  },
  {
    id: 'python-fastapi',
    version: 1,
    name: 'Python / FastAPI',
    runtimes: ['python'] as Runtime[],
    setupCommand: 'python -m venv .venv && .venv/bin/python -m pip install -r requirements.txt',
    runConfig: {
      command: '.venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload',
      cwd: '',
      port: 8000,
    },
    initialFile: 'main.py',
  },
] as const;
export const githubSourceSchema = z.object({
  repositoryId: z.number().int().positive(),
  installationId: z.number().int().positive(),
});
export const projectCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(''),
    runtimes: runtimesSchema,
    starterId: z.enum(['static-html', 'react-vite', 'python-fastapi']).optional(),
    githubSource: githubSourceSchema.optional(),
    cloneUrl: z
      .string()
      .max(2048)
      .optional()
      .refine(
        (v) => !v || /^https:\/\/[^\s]+$/.test(v) || /^git@[a-zA-Z0-9.-]+:[^\s]+$/.test(v),
        'Use an HTTPS or git@ SSH URL',
      ),
  })
  .refine(
    (v) => [v.starterId, v.cloneUrl, v.githubSource].filter(Boolean).length <= 1,
    'Choose one project source',
  );
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
  starterId: string | null;
  starterVersion: number | null;
  setupCommand: string;
  preparation: Preparation;
  appStatus: AppStatus;
  repository: GitHubSource | null;
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
export type TerminalInfo = {
  id: string;
  name: string;
  alive: boolean;
  isRun: boolean;
  isMainRun?: boolean;
};
export type GitStatus = {
  branch: string;
  entries: { path: string; index: string; worktree: string }[];
  initialized: boolean;
  branches: string[];
  upstream: string | null;
  ahead: number;
  behind: number;
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

export type Preparation = {
  status:
    'none' | 'required' | 'pending' | 'files' | 'installing' | 'ready' | 'failed' | 'interrupted';
  scaffolded: boolean;
  fingerprint: string | null;
  error: string | null;
};
export type AppStatus = {
  status: 'stopped' | 'starting' | 'available' | 'timeout' | 'failed';
  httpStatus?: number;
  error?: string;
  generation?: string;
};
export type WorkflowStep = {
  name: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'running' | 'succeeded' | 'failed' | 'cancelled';
};
export type PreparationJob = {
  steps: WorkflowStep[];
  id: string;
  step: string | null;
  state: string;
  log: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};
export type FileIndex = { paths: string[]; truncated: boolean };
export type WorkspacePreferences = {
  version: 1;
  tabs: string[];
  active: string;
  positions: Record<
    string,
    { line: number; column: number; scrollTop: number; scrollLeft: number }
  >;
  pane: string;
  showSidebar: boolean;
  showPreview: boolean;
  rightPanel?: 'preview' | 'agent';
  agentThread?: string;
  bottomPanelTab?: 'terminal' | 'preparation';
  showTerminal: boolean;
  leftWidth: number;
  previewWidth: number;
  terminalHeight: number;
  terminal: string;
};
export type OpenFileDiagnostic = {
  path: string;
  severity: number;
  message: string;
  line: number;
  column: number;
};
export type GitHubSource = {
  repositoryId: number;
  installationId: number;
  fullName: string;
  cloneUrl: string;
  userId: string;
  cloned?: boolean;
};
export type GitHubRepository = {
  id: number;
  fullName: string;
  cloneUrl: string;
  installationId: number;
  canPush: boolean;
};
export type SetupSuggestion = {
  runtimes: Runtime[];
  setupCommand: string;
  runConfig: { command: string; cwd: string; port: number };
  warnings: string[];
};

// Only read manifest data here. Repository scripts are never evaluated by discovery.
export function suggestSetup(
  files: Record<string, string>,
  cwd: string,
  previewHost?: string,
): SetupSuggestion {
  safeRelativePath(cwd);
  const result: SetupSuggestion = {
    runtimes: [],
    setupCommand: '',
    runConfig: { command: '', cwd, port: 3000 },
    warnings: [],
  };
  const sameDependencies = (a: Record<string, string> = {}, b: Record<string, string> = {}) =>
    JSON.stringify(Object.entries(a).sort(([a], [b]) => a.localeCompare(b))) ===
    JSON.stringify(Object.entries(b).sort(([a], [b]) => a.localeCompare(b)));
  if (files['package.json']) {
    result.runtimes.push('node');
    try {
      const manifest = JSON.parse(files['package.json']);
      const unsupported =
        /^(pnpm|yarn|bun)@/.test(manifest.packageManager || '') ||
        ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].some((name) => name in files);
      let compatible = false;
      for (const name of ['npm-shrinkwrap.json', 'package-lock.json'])
        if (files[name]) {
          try {
            const lock = JSON.parse(files[name]);
            compatible ||=
              [1, 2, 3].includes(lock.lockfileVersion) &&
              (!lock.packages?.[''] ||
                (sameDependencies(lock.packages[''].dependencies, manifest.dependencies) &&
                  sameDependencies(lock.packages[''].devDependencies, manifest.devDependencies)));
          } catch {}
        }
      if (unsupported)
        result.warnings.push('This package manager requires manual setup and run commands.');
      else {
        result.setupCommand = compatible ? 'npm ci' : 'npm install';
        const scripts = manifest.scripts || {},
          name =
            typeof scripts.dev === 'string'
              ? 'dev'
              : typeof scripts.start === 'string'
                ? 'start'
                : '';
        const vite =
          !!(manifest.dependencies?.vite || manifest.devDependencies?.vite) &&
          name &&
          /(?:^|\s)vite(?:\s|$)/.test(scripts[name]);
        result.runConfig.command = name
          ? `npm run ${name}${vite ? ' -- --host 0.0.0.0 --port 3000 --strictPort' : ''}`
          : '';
        if (vite && previewHost)
          result.runConfig.command = `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS='${previewHost.replaceAll("'", "'\"'\"'")}' ${result.runConfig.command}`;
        if (!name) result.warnings.push('No dev or start script found. Enter a run command.');
      }
    } catch {
      result.warnings.push('Could not parse package.json. Enter commands manually.');
    }
  }
  if (files['requirements.txt']) {
    result.runtimes.push('python');
    if (!result.setupCommand) {
      result.setupCommand =
        'python -m venv .venv && .venv/bin/python -m pip install -r requirements.txt';
      result.runConfig.port = 8000;
      const candidates = ['main.py', 'app.py'].flatMap((name) => {
        const content = files[name];
        const match = content && /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*FastAPI\(/m.exec(content);
        return match ? [`${name.slice(0, -3)}:${match[1]}`] : [];
      });
      result.runConfig.command =
        candidates.length === 1
          ? `.venv/bin/python -m uvicorn ${candidates[0]} --host 0.0.0.0 --port 8000 --reload`
          : '';
      if (candidates.length !== 1)
        result.warnings.push('FastAPI entrypoint is ambiguous or absent. Enter a run command.');
    }
  }
  if (files['go.mod']) {
    result.runtimes.push('go');
    if (!result.setupCommand) {
      result.setupCommand = 'go mod download';
      result.runConfig.command = /^package main$/m.test(files['main.go'] || '') ? 'go run .' : '';
      if (!result.runConfig.command)
        result.warnings.push('No root main.go entrypoint detected. Enter a Go run command.');
    }
  }
  if (files['Cargo.toml']) {
    result.runtimes.push('rust');
    if (!result.setupCommand) {
      result.setupCommand = 'cargo fetch';
      result.runConfig.command =
        /^\[package\]$/m.test(files['Cargo.toml']) && !/^\[lib\]$/m.test(files['Cargo.toml'])
          ? 'cargo run'
          : '';
      if (!result.runConfig.command)
        result.warnings.push('Cargo entrypoint is ambiguous. Enter a run command.');
    }
  }
  if (
    !result.runtimes.length &&
    'index.html' in files &&
    !['package.json', 'requirements.txt', 'go.mod', 'Cargo.toml'].some((name) => name in files)
  ) {
    const starter = starterCatalog.find((s) => s.id === 'static-html')!;
    result.runtimes.push(...starter.runtimes);
    result.runConfig = { ...starter.runConfig, cwd };
  }
  if (!result.runtimes.length)
    result.warnings.push(
      'No supported manifest found. Choose a runtime and enter commands manually.',
    );
  if (result.runtimes.length > 1)
    result.warnings.push('Multiple runtimes detected. Confirm commands and working directory.');
  return result;
}

export * from './agent.js';
export * from './agentProjection.js';

export * from './workspace.js';
export * from './attachments.js';
