import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const binary = process.env.CODEX_BINARY || 'codex';
if (execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim() !== 'codex-cli 0.160.0')
  throw new Error('Protocol generation requires Codex 0.160.0');
for (const [command, directory] of [
  ['generate-ts', 'src/generated'],
  ['generate-json-schema', 'schemas'],
])
  execFileSync(
    binary,
    [
      'app-server',
      command,
      '--experimental',
      '--out',
      fileURLToPath(new URL('../packages/codex-protocol/' + directory, import.meta.url)),
    ],
    { stdio: 'inherit' },
  );

// Normalize generated type-only imports for Node ESM without changing protocol types.
function normalize(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) normalize(file);
    else if (file.endsWith('.ts'))
      writeFileSync(
        file,
        readFileSync(file, 'utf8')
          .replace(/from "(\.[^"]+?)(?:\.js)?"/g, 'from "$1.js"')
          .replace('from "./v2.js"', 'from "./v2/index.js"'),
      );
  }
}
normalize(fileURLToPath(new URL('../packages/codex-protocol/src/generated', import.meta.url)));
