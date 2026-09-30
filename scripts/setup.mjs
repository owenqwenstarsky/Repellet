import { randomBytes } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
try {
  await readFile(new URL('../.env', import.meta.url));
  console.log('.env already exists; left unchanged.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  await writeFile(
    new URL('../.env', import.meta.url),
    template
      .replace('GENERATE_WORKER_TOKEN', randomBytes(32).toString('hex'))
      .replace('GENERATE_ENCRYPTION_KEY', randomBytes(32).toString('hex'))
      .replaceAll('GENERATE_DATABASE_PASSWORD', randomBytes(24).toString('hex')),
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    'Created .env with unique installation keys. Run docker compose up --build -d, then find the setup token in docker compose logs app.',
  );
}
