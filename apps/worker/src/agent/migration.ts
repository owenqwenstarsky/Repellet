import { PassThrough } from 'node:stream';
import { docker, BASE_IMAGE, ensureBase } from '../images.js';
import { volumeName } from '../workspaces.js';
import { projectId } from '../config.js';
import { createRequire } from 'node:module';
import { config } from '../config.js';
import path from 'node:path';

export type MigrationResult = {
  imported: number;
  skipped: number;
  errors: string[];
  importedConversations: string[];
  skippedConversations: string[];
};
// Same implementation as the workspace host; original JSONL files are never modified.
export async function importCodexHistory(
  source: string,
  sessions: string,
  index: string,
): Promise<MigrationResult> {
  const helper = createRequire(import.meta.url)(path.join(config.context, 'docker/pi-session.cjs'));
  return helper.importHistory(source, sessions, index);
}
export async function importProjectHistory(ids: string[]): Promise<MigrationResult> {
  const total: MigrationResult = {
    imported: 0,
    skipped: 0,
    errors: [],
    importedConversations: [],
    skippedConversations: [],
  };
  await ensureBase();
  for (const id of new Set(ids.map(projectId))) {
    try {
      await docker.getVolume(volumeName(id, 'agent')).inspect();
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) continue;
      throw error;
    }
    const helper = await docker.createContainer({
      Image: BASE_IMAGE,
      User: '1001:1000',
      Entrypoint: ['/opt/repellet/node/bin/node'],
      Cmd: ['/opt/repellet/pi-host.cjs', '--import'],
      AttachStdout: true,
      AttachStderr: true,
      Env: ['HOME=/home/agent'],
      Labels: { 'repellet.helper': 'true' },
      HostConfig: {
        NetworkMode: 'none',
        CapDrop: ['ALL'],
        Mounts: [{ Type: 'volume', Source: volumeName(id, 'agent'), Target: '/home/agent' }],
      },
    });
    try {
      const stream = await helper.attach({ stream: true, stdout: true, stderr: true });
      const output = new PassThrough(),
        errors = new PassThrough();
      docker.modem.demuxStream(stream, output, errors);
      errors.resume();
      let result = '';
      output.on('data', (chunk) => {
        result += chunk.toString();
      });
      await helper.start();
      const completed = new Promise<void>((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      if ((await helper.wait()).StatusCode !== 0) throw new Error('History import failed');
      await completed;
      const value = JSON.parse(result) as MigrationResult;
      total.imported += value.imported;
      total.skipped += value.skipped;
      total.errors.push(...value.errors);
      total.importedConversations.push(...value.importedConversations);
      total.skippedConversations.push(...value.skippedConversations);
    } catch {
      total.errors.push(
        'A project history could not be imported. Its original files were preserved.',
      );
    } finally {
      await helper.remove({ force: true }).catch(() => {});
    }
  }
  return total;
}
