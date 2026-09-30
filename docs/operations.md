# Operations

## Installation and networking

Run `npm run setup` once to generate a private `.env`. It is ignored by Git and contains database credentials, a worker token, and the encryption key. Never replace an existing `.env` to troubleshoot a running installation.

Set `PUBLIC_URL` to the exact IDE URL and `BIND_ADDRESS` to an interface address (`127.0.0.1` by default, `0.0.0.0` for LAN/VPN). The app's port is `APP_PORT`. `PREVIEW_PORT_RANGE` controls both the worker listeners and Compose's published range; keep it identical on both sides. Each running workspace reserves one preview port. Ports must be free on the host.

Linux uses `/var/run/docker.sock`; set `DOCKER_SOCKET_PATH` if your installation uses another socket. Docker Desktop exposes the daemon to the worker through its mounted socket, while project files live in Docker volumes within its VM. Allocate enough Docker Desktop memory for image builds and concurrently active workspaces. AMD64/ARM64 runtime images are selected natively by Docker.

Inspect services with `docker compose ps`, `docker compose logs app worker`, and `/api/health`. The API's health JSON includes worker availability. Worker builds report logs in the workspace; registry/network errors can be retried. Docker image caches can be large; inspect disk with `docker system df`. Avoid volume pruning: workspace volumes are not declared in Compose and contain project data.

## Optional HTTPS

A private reverse proxy can terminate TLS on the IDE and every port in your preview range. For example, with a shorter `.env` range `41000-41003`:

```caddyfile
https://ide.internal:443 {
    tls internal
    reverse_proxy 127.0.0.1:3000
}
https://ide.internal:41000 {
    tls internal
    reverse_proxy 127.0.0.1:41000
}
https://ide.internal:41001 {
    tls internal
    reverse_proxy 127.0.0.1:41001
}
https://ide.internal:41002 {
    tls internal
    reverse_proxy 127.0.0.1:41002
}
https://ide.internal:41003 {
    tls internal
    reverse_proxy 127.0.0.1:41003
}
```

Set `PUBLIC_URL=https://ide.internal`, `TRUST_PROXY=true`, and `BIND_ADDRESS=127.0.0.1`. Bind Caddy to a separate LAN/VPN IP when listening on preview ports that Docker publishes on loopback; add `bind YOUR_LAN_OR_VPN_IP` to these sites. Install/trust your CA on client devices and resolve the hostname through local DNS or hosts files. Caddy proxies WebSocket upgrades automatically. Avoid putting untrusted proxies in front of the app when TRUST_PROXY is enabled. An HTTPS IDE needs HTTPS previews to avoid browser mixed-content blocking.

## Accounts, limits, secrets

The first owner account cannot be disabled. Owners create accounts, reset passwords, disable users, inspect projects, and stop workspaces. Disabling accounts revokes sessions immediately and retains project files. Editors can edit, execute, use Git, and access injected secrets. Viewers can read, watch terminals, and open previews. Only project owners/site owner manage settings, membership, and deletion.

CPU/memory/PID limits are enforced by Docker; workspace swap is disabled. Storage includes `/workspace` and user home and is monitored every 30 seconds. When exceeded, execution and language servers suspend; IDE writes/uploads fail, while file deletion remains available. Terminal writes can overshoot between measurements. Over-limit workspaces can be opened for file cleanup; execution stays suspended until usage falls below the quota or the site owner raises it. They continue to count toward the active-project limit. Image caches and database storage are outside the project quota.

Idle shutdown depends on connected IDE clients or authenticated preview requests; open idle sockets/keepalives alone do not count as preview activity. WebSocket HMR activity without new authenticated HTTP requests does not keep a detached workspace active. Changing installation limits updates running containers.

## Upgrades and restart recovery

Back up first. Stop workspaces, pull the source update, run `npm ci`, then `docker compose up --build -d`. Startup applies checksum-verified SQL migrations and reconciles project containers. Preserve `.env` and all volumes. Never run `docker compose down -v` on an installation you want to retain. Old project images remain usable until you recreate/rebuild their containers. Runtime dependency installations may need refreshing after toolchain updates.

A crashed app process appears in Run logs with its exit code/signal. Run starts it again. A stopped/crashed workspace can be opened again; files and home configuration persist. Memory exhaustion is reported when Docker marks the container OOM-killed. Repeated failures should be diagnosed in worker/container logs or by increasing owner-configured limits. A failed runtime build preserves the previous image; reopen with its existing runtime configuration to recover.

## Troubleshooting

- **Read-only editor:** viewers are read-only; otherwise check the document connection indicator, account/membership, and workspace state. Refresh after updating the frontend. A disconnected editor pauses editing until reconnect.
- **Preview says Waiting for your app:** set a run command, bind to `0.0.0.0`, match the saved port, and inspect Run logs. Node/Vite often need `--host 0.0.0.0`.
- **Origin rejected:** use the configured PUBLIC_URL hostname/scheme/port consistently. Restart after changing it.
- **Git fails:** configure an SSH key or credential helper inside the workspace; terminal prompts are unavailable to Git panel operations. Use the terminal to complete interactive authentication.
- **Dependency errors:** install dependencies inside the project environment. Use a Python virtual environment or project-local Node dependencies. Workspace/home installations persist.
- **Disk conflict:** choose either shared resolution after comparing editor and disk content. Dirty documents are preserved in the database across stops/restarts.
- **No preview ports:** stop another workspace or expand PREVIEW_PORT_RANGE and recreate worker with `docker compose up -d --force-recreate worker`.
