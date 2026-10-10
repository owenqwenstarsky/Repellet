import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  workspace: null as any,
  markers: new Map<string, string>(),
  calls: [] as string[],
  helpers: [] as any[],
  workspaceAccess: new Map<string, boolean>(),
  migrationExit: 0,
  migrationWait: null as Promise<{ StatusCode: number }> | null,
  probeError: null as { statusCode: number } | null,
}));
vi.mock('../apps/worker/src/config.js', () => ({
  config: { inDocker: true, network: 'test-network' },
  projectId: (id: string) => id,
  bridgeToken: () => 'test-token',
}));
vi.mock('../apps/worker/src/images.js', () => {
  const container = {
    inspect: async () => {
      if (!state.workspace) throw { statusCode: 404 };
      return state.workspace;
    },
    start: vi.fn(async () => {
      state.calls.push('workspace.start');
      state.workspace.State.Running = true;
    }),
    stop: async () => {
      state.calls.push('workspace.stop');
      state.workspace.State.Running = false;
    },
    remove: async () => {
      state.calls.push('workspace.remove');
      state.workspace = null;
    },
    update: async () => state.calls.push('workspace.update'),
  };
  return {
    BASE_IMAGE: 'test-base-image',
    ensureImage: vi.fn(async () => 'test-image'),
    docker: {
      getNetwork: () => ({ inspect: async () => ({}) }),
      getImage: () => ({ inspect: async () => ({ Id: 'image-id' }) }),
      getVolume: () => ({ inspect: async () => ({}) }),
      getContainer: () => container,
      createContainer: async (options: any) => {
        // Docker copies image directory metadata into empty volumes at container
        // creation, even when a persistent migration marker already exists.
        for (const mount of options.HostConfig.Mounts) {
          if (['/workspace', '/source'].includes(mount.Target) && !mount.VolumeOptions?.NoCopy)
            state.workspaceAccess.set(mount.Source, false);
        }
        if (options.name) {
          state.workspace = {
            Id: 'container-id',
            Image: 'image-id',
            State: { Running: false },
            Mounts: options.HostConfig.Mounts.map((mount: any) => ({
              Destination: mount.Target,
            })),
          };
          return container;
        }
        const migration = options.Cmd[0].includes(workspacePermissionMarker);
        const kind = migration ? 'permissions' : options.Cmd[0].startsWith('cp ') ? 'copy' : 'init';
        const agentVolume = options.HostConfig.Mounts.find(
          (mount: any) => mount.Target === '/home/agent',
        )?.Source;
        const helper = {
          options,
          getArchive: vi.fn(async () => {
            state.calls.push('permissions.probe');
            if (state.probeError) throw state.probeError;
            if (state.markers.get(agentVolume) !== workspacePermissionMarker)
              throw { statusCode: 404 };
            return Readable.from([Buffer.alloc(0)]);
          }),
          start: vi.fn(async () => state.calls.push(kind + '.start')),
          wait: vi.fn(async () => {
            const result = migration
              ? state.migrationWait
                ? await state.migrationWait
                : { StatusCode: state.migrationExit }
              : { StatusCode: 0 };
            state.calls.push(kind + '.finish');
            if (migration && result.StatusCode === 0)
              state.markers.set(agentVolume, workspacePermissionMarker);
            if (result.StatusCode === 0 && (migration || kind === 'init')) {
              const workspaceVolume = options.HostConfig.Mounts.find(
                (mount: any) => mount.Target === '/workspace',
              ).Source;
              state.workspaceAccess.set(workspaceVolume, true);
            }
            return result;
          }),
          remove: vi.fn(async () => state.calls.push(kind + '.remove')),
        };
        state.helpers.push(helper);
        return helper;
      },
    },
  };
});

import {
  ensureWorkspace,
  stopWorkspace,
  duplicateWorkspace,
} from '../apps/worker/src/workspaces.js';
import { workspacePermissionMarker } from '../apps/worker/src/workspace-permissions.js';

const options = {
  runtimes: [],
  limits: { cpu: 2, memoryMb: 2048, storageMb: 5120, maxActiveProjects: 3, idleMinutes: 30 },
  environment: {},
};
function existingWorkspace(running = false) {
  return {
    Id: 'container-id',
    Image: 'image-id',
    State: { Running: running },
    Mounts: [{ Destination: '/home/agent' }, { Destination: '/home/agent/attachments' }],
  };
}
function permissionHelpers() {
  return state.helpers.filter((helper) =>
    helper.options.Cmd[0].includes(workspacePermissionMarker),
  );
}
beforeEach(() => {
  state.workspace = existingWorkspace();
  state.markers.clear();
  state.calls.length = 0;
  state.helpers.length = 0;
  state.workspaceAccess.clear();
  state.migrationExit = 0;
  state.migrationWait = null;
  state.probeError = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ bytes: 0, exceeded: false }))),
  );
});
afterEach(() => vi.unstubAllGlobals());

it('waits for the existing workspace migration to finish before launching its bridge', async () => {
  let release!: (result: { StatusCode: number }) => void;
  state.migrationWait = new Promise((resolve) => {
    release = resolve;
  });
  const startup = ensureWorkspace('project', options);
  await vi.waitFor(() => expect(permissionHelpers()[0]?.wait).toHaveBeenCalled());
  expect(state.calls).not.toContain('workspace.start');
  expect(fetch).not.toHaveBeenCalled();
  release({ StatusCode: 0 });
  await startup;
  expect(state.calls.indexOf('permissions.finish')).toBeLessThan(
    state.calls.indexOf('workspace.start'),
  );
  expect(state.markers.has('repellet-project-agent')).toBe(true);
  expect(permissionHelpers()[0].remove).toHaveBeenCalledWith({ force: true });
});

it('skips permission changes on later starts using the marker in the persistent agent volume', async () => {
  await ensureWorkspace('project', options);
  await stopWorkspace('project');
  await ensureWorkspace('project', options);
  const [first, second] = permissionHelpers();
  expect(first.start).toHaveBeenCalledTimes(1);
  expect(second.getArchive).toHaveBeenCalledWith({ path: workspacePermissionMarker });
  expect(second.start).not.toHaveBeenCalled();
  expect(second.wait).not.toHaveBeenCalled();
  expect(second.remove).toHaveBeenCalledWith({ force: true });
  expect(state.calls.filter((call) => call === 'workspace.start')).toHaveLength(2);
});

it('keeps the migration marker through container recreation and scopes it to the project', async () => {
  await ensureWorkspace('project', options);
  await stopWorkspace('project');
  state.workspace = null;
  await ensureWorkspace('project', options);
  expect(permissionHelpers()[1].start).not.toHaveBeenCalled();
  state.workspace = existingWorkspace();
  await ensureWorkspace('other-project', options);
  expect(permissionHelpers()[2].start).toHaveBeenCalled();
  expect(state.markers.has('repellet-other-project-agent')).toBe(true);
});

it('preserves agent access to an empty workspace on restart and container recreation', async () => {
  state.workspace = null;
  await ensureWorkspace('project', options);
  expect(state.workspaceAccess.get('repellet-project-files')).toBe(true);
  await stopWorkspace('project');
  await ensureWorkspace('project', options);
  expect(permissionHelpers()[1].start).not.toHaveBeenCalled();
  expect(state.workspaceAccess.get('repellet-project-files')).toBe(true);
  await stopWorkspace('project');
  state.workspace = null;
  await ensureWorkspace('project', options);
  expect(permissionHelpers()[2].start).not.toHaveBeenCalled();
  expect(state.workspaceAccess.get('repellet-project-files')).toBe(true);
});

it('repairs volumes with an old marker before starting their bridge', async () => {
  state.markers.set('repellet-project-agent', '/home/agent/.repellet-workspace-permissions-v1');
  state.workspaceAccess.set('repellet-project-files', false);
  await ensureWorkspace('project', options);
  expect(permissionHelpers()[0].start).toHaveBeenCalled();
  expect(state.workspaceAccess.get('repellet-project-files')).toBe(true);
  expect(state.markers.get('repellet-project-agent')).toBe(workspacePermissionMarker);
  expect(state.calls.indexOf('permissions.finish')).toBeLessThan(
    state.calls.indexOf('workspace.start'),
  );
});

it('prepares new volumes before migrating permissions and starting a new workspace', async () => {
  state.workspace = null;
  await ensureWorkspace('project', options);
  expect(state.calls.indexOf('init.finish')).toBeLessThan(state.calls.indexOf('permissions.start'));
  expect(state.calls.indexOf('permissions.finish')).toBeLessThan(
    state.calls.indexOf('workspace.start'),
  );
});

it('does not migrate a workspace whose bridge is already running', async () => {
  state.workspace = existingWorkspace(true);
  await ensureWorkspace('project', options);
  expect(permissionHelpers()).toEqual([]);
  expect(state.calls).toContain('workspace.update');
  expect(state.calls).not.toContain('workspace.stop');
});

it('leaves a failed migration retryable and never launches the bridge on failure', async () => {
  state.migrationExit = 1;
  await expect(ensureWorkspace('project', options)).rejects.toThrow(
    'Could not prepare workspace filesystem permissions',
  );
  expect(state.markers.size).toBe(0);
  expect(state.calls).not.toContain('workspace.start');
  expect(permissionHelpers()[0].remove).toHaveBeenCalled();
  state.migrationExit = 0;
  await ensureWorkspace('project', options);
  expect(permissionHelpers()[1].start).toHaveBeenCalled();
  expect(state.workspace.State.Running).toBe(true);
});

it('does not interpret a marker read error as an absent marker', async () => {
  state.probeError = { statusCode: 403 };
  await expect(ensureWorkspace('project', options)).rejects.toEqual(state.probeError);
  expect(permissionHelpers()[0].start).not.toHaveBeenCalled();
  expect(permissionHelpers()[0].remove).toHaveBeenCalled();
  expect(state.calls).not.toContain('workspace.start');
});

it('migrates a duplicate after copying files without inheriting the source marker', async () => {
  state.workspace = null;
  state.markers.set('repellet-source-agent', workspacePermissionMarker);
  state.workspaceAccess.set('repellet-source-files', true);
  await duplicateWorkspace('source', 'project');
  expect(state.workspaceAccess.get('repellet-source-files')).toBe(true);
  expect(state.markers.has('repellet-project-agent')).toBe(false);
  await ensureWorkspace('project', options);
  expect(state.calls.indexOf('copy.finish')).toBeLessThan(state.calls.indexOf('permissions.start'));
  expect(permissionHelpers()[0].start).toHaveBeenCalled();
});

it.each(['replacement', 'rebuild'])(
  'stops a running workspace before %s migration',
  async (kind) => {
    state.workspace = existingWorkspace(true);
    if (kind === 'replacement') state.workspace.Image = 'old-image';
    await ensureWorkspace('project', { ...options, rebuild: kind === 'rebuild' });
    expect(state.calls.indexOf('workspace.stop')).toBeLessThan(
      state.calls.indexOf('permissions.start'),
    );
    expect(state.calls.indexOf('permissions.finish')).toBeLessThan(
      state.calls.indexOf('workspace.start'),
    );
  },
);

it('records success only after all permission commands and keeps private state out of the workspace', async () => {
  await ensureWorkspace('project', options);
  const { Cmd, HostConfig } = permissionHelpers()[0].options;
  const steps = Cmd[0].split(' && ');
  expect(steps.slice(0, -1).every((step: string) => step.includes('/workspace'))).toBe(true);
  expect(steps.at(-1)).toBe(`touch ${workspacePermissionMarker}`);
  expect(steps.slice(0, -1).join(' && ')).not.toContain('/home/agent');
  expect(HostConfig.NetworkMode).toBe('none');
  expect(HostConfig.Mounts).toEqual([
    {
      Type: 'volume',
      Source: 'repellet-project-files',
      Target: '/workspace',
      VolumeOptions: { NoCopy: true },
    },
    { Type: 'volume', Source: 'repellet-project-agent', Target: '/home/agent' },
  ]);
});
