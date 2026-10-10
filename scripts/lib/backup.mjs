import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
export async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function createBackup({ destination, envFile, dump, volumes, archiveVolume }) {
  await mkdir(destination, { mode: 0o700 });
  const manifest = { version: 1, createdAt: new Date().toISOString(), files: [], volumes: [] };
  await writeFile(path.join(destination, '.env'), await readFile(envFile), {
    mode: 0o600,
    flag: 'wx',
  });
  await dump(path.join(destination, 'database.dump'));
  for (const volume of volumes) {
    if (!isBackupVolume(volume)) throw new Error('Unexpected workspace volume name');
    const file = volume + '.tar.gz';
    await archiveVolume(volume, path.join(destination, file));
    manifest.volumes.push({ name: volume, file });
  }
  for (const file of ['.env', 'database.dump', ...manifest.volumes.map((v) => v.file)])
    manifest.files.push({
      file,
      sha256: await digest(path.join(destination, file)),
      bytes: (await stat(path.join(destination, file))).size,
    });
  await writeFile(
    path.join(destination, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  return manifest;
}
export async function verifyBackup(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.volumes))
    throw new Error('Unsupported backup format');
  const names = new Set();
  for (const entry of manifest.files) {
    if (
      typeof entry.file !== 'string' ||
      entry.file.includes('/') ||
      entry.file.includes('\\') ||
      entry.file === '..' ||
      names.has(entry.file)
    )
      throw new Error('Invalid backup filename');
    names.add(entry.file);
    if ((await digest(path.join(directory, entry.file))) !== entry.sha256)
      throw new Error('Backup checksum failed: ' + entry.file);
  }
  if (!names.has('.env') || !names.has('database.dump'))
    throw new Error('Backup is missing the database or installation keys');
  const volumeNames = new Set();
  for (const volume of manifest.volumes) {
    if (
      !isBackupVolume(volume.name) ||
      volume.file !== volume.name + '.tar.gz' ||
      !names.has(volume.file) ||
      volumeNames.has(volume.name)
    )
      throw new Error('Invalid volume manifest');
    volumeNames.add(volume.name);
  }
  return manifest;
}
export async function restoreBackup({
  directory,
  restoreDatabase,
  restoreVolume,
  restoreEnvironment,
}) {
  const manifest = await verifyBackup(directory);
  await restoreEnvironment(await readFile(path.join(directory, '.env')));
  await restoreDatabase(path.join(directory, 'database.dump'));
  for (const volume of manifest.volumes)
    await restoreVolume(volume.name, path.join(directory, volume.file));
  return manifest;
}

/** Quiesce only this installation's project database containers before volume archives. */
export async function stopProjectDatabases(ids, run, remove = false) {
  for (const id of ids) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid stored project ID');
    const name = 'repellet-database-' + id;
    const exists = await run(
      ['ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}'],
      { capture: true },
    );
    if (exists) await run(remove ? ['rm', '-f', exists] : ['stop', '--time', '20', exists]);
  }
}
export function isBackupVolume(name) {
  return /^(?:repellet-[a-f0-9-]{36}-(?:files|home|agent|attachments|database)|repellet-agent-accounts)$/.test(
    name,
  );
}
