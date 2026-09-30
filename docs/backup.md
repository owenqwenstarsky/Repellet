# Backup and restore

The operator scripts require Node.js 22+, Docker/Compose, and the project's npm dependencies. Run them from the installation directory. These scripts target the Compose deployment; a standalone development server must be stopped/backed up separately.

## Consistent backup

```sh
npm run backup -- .backups/2026-09-29
npm run backup:verify -- .backups/2026-09-29
```

Use a new destination directory each time. Backup enters maintenance mode, drains pending document edits, stops project workloads, and stops the app/worker while PostgreSQL stays available. It captures:

- PostgreSQL custom-format dump, including accounts, projects, membership, Yjs state, encrypted variables, and migration records.
- Existing workspace files and home volumes for every database project, preserving file ownership/modes, symlinks, Git credentials, and dependencies.
- The full `.env`, including the encryption key, worker token, and database password.
- A versioned manifest with SHA-256 checksums.

App/worker services are restarted and maintenance mode cleared afterward. Project workloads stay stopped; users reopen them. Unresolved editor conflicts remain in durable database state, so restoration retains the choice instead of silently overwriting workspace files.

The backup directory is private (`0700`) and its files are private (`0600`). It is **not encrypted** and contains secrets/credentials. Store it in an encrypted off-host backup system. Image caches are rebuildable and not included. Other host data and volumes unrelated to database projects are excluded. A directory without a complete manifest is an incomplete backup and must not be restored.

## Restore

Restore is explicitly destructive to the target installation. Use an isolated installation for rehearsals. Match the application version to the backup before applying later migrations.

```sh
npm run backup:verify -- /path/to/snapshot
npm run restore -- /path/to/snapshot --confirm=REPLACE
# Review restored .env; adjust PUBLIC_URL/BIND_ADDRESS for the target host.
docker compose up -d --force-recreate database worker app
```

The target PostgreSQL service must already be running. Start a fresh target with `npm run setup` and `docker compose up -d database` first. Restore verifies all checksums before modifying data, stops app/worker, removes recorded project containers, restores the database and matching volumes, installs the original encryption key/configuration, resets maintenance/state, and revokes old sessions. The previous `.env` is saved as `.env.pre-restore` (also sensitive). It updates the PostgreSQL role password to match the restored `.env`; force-recreate the database service afterward so its environment agrees.

Restore clears each matching volume before extracting the archive. Unrelated and old orphaned volumes are retained; inspect them before manual removal. The database service and restored roles use the standard `repellet` user/database. Custom Compose configurations can be selected with `REPELLET_COMPOSE_FILE` and a configuration file with `REPELLET_ENV_FILE`; custom database role/name layouts require adapting the script. Do not restore untrusted archives: hashes detect corruption but do not authenticate a backup's creator.

After restoration, sign in, inspect project files, open a mixed-runtime project, read configured variables, and run its command. Restore does not restart project processes automatically. Losing the encryption key makes stored environment variables unrecoverable. Keep the source version, `.env`, dump, and volume archives together.
