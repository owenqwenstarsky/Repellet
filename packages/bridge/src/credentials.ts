// A read-only, operation-scoped helper. Git invokes it with get/store/erase;
// only get can return credentials, and only for the validated host and path.
export function credentialResponse(input: string, action: string, remote: string, token: string) {
  const fields = Object.fromEntries(
    input
      .trim()
      .split('\n')
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
  const target = new URL(remote);
  if (
    action !== 'get' ||
    target.protocol !== 'https:' ||
    target.hostname !== 'github.com' ||
    target.port ||
    target.username ||
    target.password ||
    fields.protocol !== 'https' ||
    fields.host !== 'github.com' ||
    fields.path !== target.pathname.slice(1) ||
    /[\r\n]/.test(token)
  )
    return '';
  return `username=x-access-token\npassword=${token}\n\n`;
}
if (process.argv[1]?.endsWith('/credentials.js')) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    input += data;
    if (input.length > 8192) process.exit(1);
  });
  process.stdin.on('end', () => {
    try {
      process.stdout.write(
        credentialResponse(
          input,
          process.argv[2] || '',
          process.env.REPELLET_GIT_REMOTE || '',
          process.env.REPELLET_GIT_TOKEN || '',
        ),
      );
    } catch {
      process.exitCode = 1;
    }
  });
}
