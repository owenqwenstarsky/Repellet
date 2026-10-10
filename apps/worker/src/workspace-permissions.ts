import { finished } from 'node:stream/promises';
import { docker, BASE_IMAGE } from './images.js';

export const workspacePermissionMarker = '/home/agent/.repellet-workspace-permissions-v1';

/** Run with the workspace stopped so permission changes cannot flood its file watcher. */
export async function prepareWorkspacePermissions(workspaceVolume: string, agentVolume: string) {
  const helper = await docker.createContainer({
    Image: BASE_IMAGE,
    User: '0:0',
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: [
      `chgrp -R 1000 /workspace && chmod g+rwX /workspace && find /workspace -type d -exec chmod g+s {} + && setfacl -R -m g:1000:rwX /workspace && find /workspace -type d -exec setfacl -m d:g:1000:rwx,d:m:rwx {} + && touch ${workspacePermissionMarker}`,
    ],
    HostConfig: {
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
      Mounts: [
        { Type: 'volume', Source: workspaceVolume, Target: '/workspace' },
        { Type: 'volume', Source: agentVolume, Target: '/home/agent' },
      ],
    },
    Labels: { 'repellet.helper': 'true' },
  });
  try {
    try {
      // Docker can read mounted volumes from a stopped helper. An existing marker
      // avoids starting the helper or touching workspace metadata on later starts.
      const archive = await helper.getArchive({ path: workspacePermissionMarker });
      archive.resume();
      await finished(archive);
      return;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
    await helper.start();
    if ((await helper.wait()).StatusCode !== 0)
      throw new Error('Could not prepare workspace filesystem permissions');
  } finally {
    await helper.remove({ force: true }).catch(() => {});
  }
}
