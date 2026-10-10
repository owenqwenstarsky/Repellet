import { runDocker as run } from './lib/docker.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { createBackup, verifyBackup, restoreBackup, stopProjectDatabases } from './lib/backup.mjs';
const [operation, location, ...flags] = process.argv.slice(2);
const envFile = path.resolve(process.env.REPELLET_ENV_FILE || '.env');
const compose = [
  'compose',
  '--env-file',
  envFile,
  ...(process.env.REPELLET_COMPOSE_FILE ? ['-f', process.env.REPELLET_COMPOSE_FILE] : []),
];
const docker = process.env.DOCKER_CLI || 'docker';
const archiveImage = 'debian:bookworm-slim';
const maintenance = (enabled) =>
  run([
    ...compose,
    'exec',
    '-T',
    'app',
    'node',
    '-e',
    `fetch('http://localhost:3000/internal/maintenance',{method:'POST',headers:{authorization:'Bearer '+process.env.WORKER_TOKEN,'content-type':'application/json'},body:JSON.stringify({enabled:${enabled}})}).then(async r=>{if(!r.ok)throw new Error(await r.text())}).catch(e=>{console.error(e.message);process.exit(1)})`,
  ]);
const query = (sql) =>
  run(
    [
      ...compose,
      'exec',
      '-T',
      'database',
      'psql',
      '-U',
      'repellet',
      '-d',
      'repellet',
      '-At',
      '-c',
      sql,
    ],
    { capture: true },
  );
async function projectVolumes() {
  const ids = (await query('SELECT id FROM projects ORDER BY id')).split('\n').filter(Boolean);
  const volumes = [];
  for (const id of ids)
    for (const kind of ['files', 'home', 'agent', 'attachments', 'database']) {
      const name = `repellet-${id}-${kind}`;
      const found = await run(
        ['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'],
        { capture: true },
      );
      if (found === name) volumes.push(name);
    }
  const accounts = await run(
    ['volume', 'ls', '--filter', 'name=^repellet-agent-accounts$', '--format', '{{.Name}}'],
    { capture: true },
  );
  if (accounts === 'repellet-agent-accounts') volumes.push(accounts);
  return volumes;
}
try {
  if (!location || !['backup', 'verify', 'restore'].includes(operation))
    throw new Error(
      'Usage: node scripts/backup.mjs backup|verify|restore DIRECTORY [--confirm=REPLACE]',
    );
  const directory = path.resolve(location);
  if (operation === 'verify') {
    const m = await verifyBackup(directory);
    console.log(`Verified ${m.files.length} files, ${m.volumes.length} volumes.`);
  } else if (operation === 'backup') {
    try {
      await maintenance(true);
      await stopProjectDatabases(
        (await query('SELECT id FROM projects ORDER BY id')).split('\n').filter(Boolean),
        run,
      );
      await run([...compose, 'stop', 'app', 'worker']);
      const volumes = await projectVolumes();
      await createBackup({
        destination: directory,
        envFile,
        volumes,
        dump: (file) =>
          run(
            [
              ...compose,
              'exec',
              '-T',
              'database',
              'pg_dump',
              '-U',
              'repellet',
              '-d',
              'repellet',
              '-Fc',
            ],
            { output: file },
          ),
        archiveVolume: (volume, file) =>
          run(
            [
              'run',
              '--rm',
              '--network',
              'none',
              '--mount',
              `type=volume,source=${volume},target=/source,readonly`,
              archiveImage,
              'tar',
              '-C',
              '/source',
              '-czpf',
              '-',
              '.',
            ],
            { output: file },
          ),
      });
      console.log('Backup complete: ' + directory);
    } finally {
      await run([...compose, 'up', '-d', '--wait', 'worker', 'app']);
      await maintenance(false);
    }
  } else {
    if (!flags.includes('--confirm=REPLACE'))
      throw new Error(
        'Restore replaces this installation’s database, keys, and matching volumes. Re-run with --confirm=REPLACE after verifying the target installation.',
      );
    const manifest = await verifyBackup(directory);
    await run([...compose, 'stop', 'app', 'worker']);
    // Containers carry bridge tokens derived from the old installation key; remove them before restoring.
    const oldIds = (await query('SELECT id FROM projects').catch(() => ''))
      .split('\n')
      .filter(Boolean);
    const restoreIds = [
      ...new Set([
        ...oldIds,
        ...manifest.volumes
          .filter(
            (volume) =>
              volume.name.startsWith('repellet-') && volume.name !== 'repellet-agent-accounts',
          )
          .map((volume) => volume.name.slice(9, 45)),
      ]),
    ];
    await stopProjectDatabases(restoreIds, run, true);
    for (const id of restoreIds) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid stored project ID');
      const name = 'repellet-project-' + id;
      const exists = await run(
        ['ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}'],
        { capture: true },
      );
      if (exists) await run(['rm', '-f', exists]);
    }
    await restoreBackup({
      directory,
      restoreEnvironment: async (contents) => {
        await writeFile(envFile + '.pre-restore', await readFile(envFile), { mode: 0o600 });
        await writeFile(envFile, contents, { mode: 0o600 });
      },
      restoreDatabase: (file) =>
        run(
          [
            ...compose,
            'exec',
            '-T',
            'database',
            'pg_restore',
            '-U',
            'repellet',
            '-d',
            'repellet',
            '--clean',
            '--if-exists',
            '--exit-on-error',
            '--no-owner',
            '--no-privileges',
          ],
          { input: file },
        ),
      restoreVolume: async (volume, file) => {
        await run(
          [
            'volume',
            'create',
            '--label',
            volume === 'repellet-agent-accounts'
              ? 'repellet.accounts=true'
              : 'repellet.project=' + volume.slice(9, 45),
            '--label',
            'repellet.kind=' + volume.split('-').at(-1),
            volume,
          ],
          { capture: true },
        );
        await run(
          [
            'run',
            '--rm',
            '-i',
            '--network',
            'none',
            '--mount',
            `type=volume,source=${volume},target=/target`,
            archiveImage,
            'sh',
            '-c',
            'find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -xzpf - -C /target',
          ],
          { input: file },
        );
      },
    });
    // The restored DB role password must match its restored installation configuration.
    const restoredEnv = parse(await readFile(envFile));
    if (!restoredEnv.DB_PASSWORD) throw new Error('Restored .env has no DB_PASSWORD');
    await run(
      [
        ...compose,
        'exec',
        '-T',
        'database',
        'psql',
        '-U',
        'repellet',
        '-d',
        'repellet',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      {
        inputText: `ALTER ROLE repellet PASSWORD '${restoredEnv.DB_PASSWORD.replaceAll("'", "''")}';\n`,
      },
    );
    await query(
      "UPDATE installation SET maintenance=false; DELETE FROM sessions; UPDATE projects SET state='stopped', preview_port=NULL; UPDATE jobs SET state='failed', error='Restored from backup' WHERE state IN ('pending','running')",
    );
    // Older backups do not contain the additive workspace tables yet. New metadata
    // is restored by pg_restore, but a restored process cannot still be running.
    await query(`DO $$ BEGIN
      IF to_regclass('project_databases') IS NOT NULL THEN
        UPDATE project_databases SET status='stopped', error=NULL WHERE status<>'deleting';
      END IF;
      IF to_regclass('workspace_processes') IS NOT NULL THEN
        UPDATE workspace_processes SET status='stopped', finished_at=now() WHERE status IN ('starting','running');
        UPDATE project_preview_targets SET allocated_port=NULL, status='stopped', http_status=NULL, last_probe=NULL;
        DELETE FROM workspace_idempotency;
      END IF;
    END $$`);
    console.log(
      `Restored ${manifest.volumes.length} volumes. Review .env (including PUBLIC_URL), then run docker compose up -d --force-recreate database worker app. Existing sessions were revoked.`,
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
