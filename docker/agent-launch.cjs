// Remove inherited container control-plane variables before executing Codex.
const { spawn } = require('node:child_process');
const env = { ...process.env };
for (const key of ['BRIDGE_TOKEN', 'WORKER_TOKEN', 'STORAGE_LIMIT_MB']) delete env[key];
const child = spawn('/usr/local/bin/codex', process.argv.slice(2), { env, stdio: 'inherit' });
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
