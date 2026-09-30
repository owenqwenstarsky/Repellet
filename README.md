# Repellet

A self-hosted browser IDE for trusted, invited users. Create projects with Python, Node.js, Go, Rust, or combinations; edit together, use real shared terminals, run apps, and open private previews. No AI features or public registration.

## Install

Requires Docker Engine + Compose v2 on Linux, or Docker Desktop on macOS (AMD64 or ARM64), and Node.js 22+ to generate configuration and run operator scripts. Allow at least 8 GiB RAM for the first source build; workspace limits are additional. Initial builds need internet access.

```sh
npm ci
npm run setup
# Edit .env: PUBLIC_URL must be the exact browser-facing IDE address.
docker compose up --build -d
docker compose logs app
```

Open `http://localhost:3000` by default. Use the **First-time setup token** in the application logs to create the owner account. Setup is permanently disabled afterward. The owner adds people under Administration; there is no registration endpoint.

For LAN or VPN access, set `BIND_ADDRESS=0.0.0.0` and `PUBLIC_URL=http://your-hostname:3000` before starting. Prefer one hostname consistently. Allow the IDE port and preview range (default `41000–41031`) through your firewall for intended users. No public DNS is required.

## Use

1. Choose a React/Vite/TypeScript or Python/FastAPI starter, a blank project, a GitHub repository, or an HTTPS/SSH clone. Starters prepare dependencies automatically and wait for Run. Select one or more runtimes. First use builds an environment; later projects reuse cached images.
2. Create/upload files in the explorer. Edits autosave; collaborators share documents, cursors, terminals, and Git state.
3. Set **Run command**, **Working directory**, and **Preview port** in project settings. Your server must bind to `0.0.0.0`. Run starts a managed process group; Stop app terminates it. Stop workspace stops the container.
4. Use Source control to stage, commit, switch/create branches, and push/pull. Connect your GitHub account for matching HTTPS remotes, or configure credentials manually in the terminal for other remotes. `/home/workspace` persists.
5. Invite existing accounts as editors or viewers in project settings. Editors can execute commands and read injected environment secrets; viewers can observe terminals and open previews.

Language services provide completion, hover, diagnostics, and definition navigation for Python, JS/TS, Go, and Rust. Format Document uses Ruff, Prettier, gofmt, or rustfmt. Project dependencies and tool configuration are available to the services inside the container.

The default limits are 2 CPUs, 2 GiB memory, 512 processes, three active projects per owner, and 5 GiB monitored storage. Containers stop after 30 minutes without connected IDE users or authenticated preview requests. Terminal-only processes and socket keepalives do not keep them awake. Change installation defaults under Administration.

## Develop and validate

```sh
npm ci
npm run setup
docker compose -f compose.yaml -f compose.dev.yaml up -d database
npm run dev
```

`npm run dev` starts Vite, API, and worker. In a development `.env`, point `DATABASE_URL` at `127.0.0.1:54329`, `WORKER_URL` at `http://127.0.0.1:3002`, and `INTERNAL_APP_URL` at `http://127.0.0.1:3000`. The Docker socket must be accessible. The initial workspace build can take several minutes.

```sh
npm run check
npm run test:docker
npm run test:e2e
npm audit
```

Database tests create disposable databases; Docker tests create disposable containers/volumes. Browser tests use their own database, ports, worker, and preview range. They never reset the owner account in your installation. Build before browser tests. See [verification notes](docs/verification.md) for platform coverage and limitations.

See [starters, workspace preferences, GitHub setup, and recovery](docs/workflows.md).

## Operate

- [Installation, HTTPS, upgrades, limits, and troubleshooting](docs/operations.md)
- [Backup and restore](docs/backup.md)
- [Architecture and security boundaries](docs/architecture.md)

Repellet is a single-host application for trusted invitees. Docker isolation is not a hostile-code sandbox. Custom Dockerfiles, public previews, publishing, debugger integration, extension marketplaces, mobile-first editing, and multiple hosts are outside this release.
