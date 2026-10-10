import { docker, ensureImage, BASE_IMAGE } from './images.js';
import { config, bridgeToken, projectId } from './config.js';
import { installManagedAgentContext } from './agent-context.js';
import { prepareWorkspacePermissions, workspaceVolumeOptions } from './workspace-permissions.js';
import type { Limits, Runtime } from '@repellet/shared';
export const containerName = (id: string) => `repellet-project-${projectId(id)}`;
export const volumeName = (id: string, kind = 'files') => `repellet-${projectId(id)}-${kind}`;
export const locks = new Map<string, Promise<unknown>>();
export async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const old = locks.get(id) || Promise.resolve();
  const current = old.catch(() => {}).then(fn);
  locks.set(id, current);
  try {
    return await current;
  } finally {
    if (locks.get(id) === current) locks.delete(id);
  }
}
export async function inspect(id: string) {
  try {
    return await docker.getContainer(containerName(id)).inspect();
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 404) return null;
    throw e;
  }
}
export async function bridgeAddress(id: string) {
  const state = await inspect(id);
  if (!state?.State.Running)
    throw Object.assign(new Error('Workspace is stopped'), { statusCode: 409 });
  if (config.inDocker) return `http://${containerName(id)}:8787`;
  const binding = state.NetworkSettings.Ports['8787/tcp']?.[0];
  if (!binding) throw new Error('Workspace bridge port is missing');
  return `http://127.0.0.1:${binding.HostPort}`;
}
export async function bridgeRequest(id: string, route: string, method = 'GET', body?: unknown) {
  const url = (await bridgeAddress(id)) + route;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${bridgeToken(id)}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(method === 'POST' && route === '/git' ? 180000 : 30000),
  });
  if (!response.ok) {
    let message = await response.text();
    let completedFiles: string[] | undefined;
    try {
      const details = JSON.parse(message);
      message = details.error || message;
      if (Array.isArray(details.completedFiles)) completedFiles = details.completedFiles;
    } catch {}
    throw Object.assign(new Error(message), { statusCode: response.status, completedFiles });
  }
  return response;
}
async function ensureNetwork() {
  try {
    await docker.getNetwork(config.network).inspect();
  } catch {
    await docker.createNetwork({ Name: config.network, CheckDuplicate: true });
  }
}
async function initVolumes(id: string) {
  for (const kind of ['files', 'home', 'agent', 'attachments']) {
    const name = volumeName(id, kind);
    try {
      await docker.getVolume(name).inspect();
    } catch {
      await docker.createVolume({
        Name: name,
        Labels: { 'repellet.project': id, 'repellet.kind': kind },
      });
    }
  }
  const helper = await docker.createContainer({
    Image: BASE_IMAGE,
    User: 'root',
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: [
      `chown 1000:1000 /workspace /home/workspace && ${installManagedAgentContext} && chown 1001:1000 /home/agent/attachments && chmod 700 /home/agent/attachments && chmod 2775 /workspace && setfacl -m g:1000:rwx,d:g:1000:rwx,d:m:rwx /workspace`,
    ],
    HostConfig: {
      AutoRemove: false,
      Mounts: [
        {
          Type: 'volume',
          Source: volumeName(id),
          Target: '/workspace',
          VolumeOptions: workspaceVolumeOptions,
        },
        { Type: 'volume', Source: volumeName(id, 'home'), Target: '/home/workspace' },
        { Type: 'volume', Source: volumeName(id, 'agent'), Target: '/home/agent' },
        {
          Type: 'volume',
          Source: volumeName(id, 'attachments'),
          Target: '/home/agent/attachments',
        },
      ],
    },
    Labels: { 'repellet.helper': 'true' },
  });
  try {
    await helper.start();
    const exit = await helper.wait();
    if (exit.StatusCode !== 0) throw new Error('Could not initialize project volumes');
  } finally {
    await helper.remove({ force: true }).catch(() => {});
  }
}
export async function prepareWorkspace(id: string, runtimes: Runtime[], rebuild = false) {
  return locked(id, async () => {
    if (rebuild) {
      const old = await inspect(id);
      if (old?.State.Running) await docker.getContainer(old.Id).stop({ t: 10 });
    }
    await ensureImage(id, runtimes);
    return { ok: true };
  });
}
export type EnsureOptions = {
  runtimes: Runtime[];
  limits: Limits;
  environment: Record<string, string>;
  rebuild?: boolean;
  prepared?: boolean;
  cloneUrl?: string;
  previewTargetPort?: number;
};
export async function ensureWorkspace(id: string, options: EnsureOptions) {
  return locked(id, async () => {
    await ensureNetwork();
    if (options.rebuild) {
      const old = await inspect(id);
      if (old?.State.Running) await docker.getContainer(old.Id).stop({ t: 10 });
    }
    const image = await ensureImage(id, options.runtimes, !options.prepared);
    let current = await inspect(id);
    const desiredImage = await docker.getImage(image).inspect();
    if (
      current &&
      (current.Image !== desiredImage.Id ||
        !current.Mounts.some((mount) => mount.Destination === '/home/agent') ||
        !current.Mounts.some((mount) => mount.Destination === '/home/agent/attachments') ||
        (!config.inDocker &&
          !current.NetworkSettings.Ports[`${options.previewTargetPort || 3000}/tcp`]))
    ) {
      if (current.State.Running) await docker.getContainer(current.Id).stop({ t: 10 });
      await docker.getContainer(current.Id).remove();
      current = null;
    }
    if (!current) {
      await initVolumes(id);
      const created = await docker.createContainer({
        name: containerName(id),
        Image: image,
        User: '1000:1000',
        Env: [`BRIDGE_TOKEN=${bridgeToken(id)}`, `STORAGE_LIMIT_MB=${options.limits.storageMb}`],
        ExposedPorts: { '8787/tcp': {}, [`${options.previewTargetPort || 3000}/tcp`]: {} },
        Labels: { 'repellet.project': id, 'repellet.managed': 'true' },
        WorkingDir: '/workspace',
        HostConfig: {
          NetworkMode: config.network,
          Memory: options.limits.memoryMb * 1024 * 1024,
          MemorySwap: options.limits.memoryMb * 1024 * 1024,
          NanoCpus: Math.floor(options.limits.cpu * 1e9),
          PidsLimit: 512,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Init: true,
          ExtraHosts: ['host.docker.internal:host-gateway'],
          Mounts: [
            {
              Type: 'volume',
              Source: volumeName(id),
              Target: '/workspace',
              VolumeOptions: workspaceVolumeOptions,
            },
            { Type: 'volume', Source: volumeName(id, 'home'), Target: '/home/workspace' },
            { Type: 'volume', Source: volumeName(id, 'agent'), Target: '/home/agent' },
            {
              Type: 'volume',
              Source: volumeName(id, 'attachments'),
              Target: '/home/agent/attachments',
              ReadOnly: true,
            },
          ],
          ...(config.inDocker
            ? {}
            : {
                PortBindings: {
                  '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }],
                  [`${options.previewTargetPort || 3000}/tcp`]: [
                    { HostIp: '127.0.0.1', HostPort: '' },
                  ],
                },
              }),
        },
      });
      await prepareWorkspacePermissions(volumeName(id), volumeName(id, 'agent'));
      await created.start();
    } else if (!current.State.Running) {
      await prepareWorkspacePermissions(volumeName(id), volumeName(id, 'agent'));
      await docker.getContainer(current.Id).start();
    } else
      await docker.getContainer(current.Id).update({
        Memory: options.limits.memoryMb * 1024 * 1024,
        MemorySwap: options.limits.memoryMb * 1024 * 1024,
        NanoCpus: Math.floor(options.limits.cpu * 1e9),
        PidsLimit: 512,
      });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        await bridgeRequest(id, '/health');
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!ready) {
      const state = await inspect(id);
      throw new Error(
        state?.State.OOMKilled
          ? 'Workspace exceeded its memory limit'
          : 'Workspace service did not start. Check worker logs.',
      );
    }
    await bridgeRequest(id, '/environment', 'PUT', options.environment);
    await bridgeRequest(id, '/limits', 'PUT', { storageMb: options.limits.storageMb });
    if (options.cloneUrl) {
      const status = (await (await bridgeRequest(id, '/git/status')).json()) as {
        initialized: boolean;
      };
      const files = (await (await bridgeRequest(id, '/files')).json()) as unknown[];
      if (!status.initialized && files.length === 0)
        await bridgeRequest(id, '/git', 'POST', { action: 'clone', url: options.cloneUrl });
    }
    const usage = (await (await bridgeRequest(id, '/usage')).json()) as {
      bytes: number;
      exceeded: boolean;
    };
    return { state: 'running', storageBytes: usage.bytes, storageExceeded: usage.exceeded };
  });
}
export async function stopWorkspace(id: string) {
  return locked(id, async () => {
    const current = await inspect(id);
    if (current?.State.Running) {
      await bridgeRequest(id, '/shutdown', 'POST').catch(() => {});
      await docker.getContainer(current.Id).stop({ t: 10 });
    }
    return { state: 'stopped' };
  });
}
export async function removeWorkspace(id: string) {
  return locked(id, async () => {
    const current = await inspect(id);
    if (current) await docker.getContainer(current.Id).remove({ force: true });
    for (const kind of ['files', 'home', 'agent', 'attachments'])
      try {
        await docker.getVolume(volumeName(id, kind)).remove();
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode !== 404) throw e;
      }
    return { ok: true };
  });
}
export async function duplicateWorkspace(from: string, to: string) {
  return locked(to, async () => {
    await initVolumes(to);
    const copy = await docker.createContainer({
      Image: BASE_IMAGE,
      User: 'root',
      Entrypoint: ['/bin/sh', '-c'],
      Cmd: ['cp -a /source/. /workspace/ && chown 1000:1000 /workspace'],
      HostConfig: {
        AutoRemove: false,
        Mounts: [
          {
            Type: 'volume',
            Source: volumeName(from),
            Target: '/source',
            ReadOnly: true,
            VolumeOptions: workspaceVolumeOptions,
          },
          {
            Type: 'volume',
            Source: volumeName(to),
            Target: '/workspace',
            VolumeOptions: workspaceVolumeOptions,
          },
        ],
      },
      Labels: { 'repellet.helper': 'true' },
    });
    try {
      await copy.start();
      const result = await copy.wait();
      if (result.StatusCode !== 0) throw new Error('Project duplication failed');
      return { ok: true };
    } finally {
      await copy.remove({ force: true }).catch(() => {});
    }
  });
}
