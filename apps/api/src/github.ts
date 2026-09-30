import { randomBytes, createPrivateKey, sign } from 'node:crypto';
import { eq, and, gt, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { GitHubRepository, GitHubSource } from '@repellet/shared';
import { githubSourceSchema } from '@repellet/shared';
import { db } from './db.js';
import { githubConfig, githubConnections, githubStates, projects } from './schema.js';
import { requireUser, requireOwner, encrypt, decrypt, tokenHash } from './security.js';
import { config } from './config.js';
import { access } from './routes.js';
import { bridge } from './worker.js';
import { serialize } from './lifecycle.js';
// Injection is deliberately restricted to tests; production only talks to github.com.
const apiBase =
  process.env.NODE_ENV === 'test' && process.env.GITHUB_TEST_API
    ? process.env.GITHUB_TEST_API
    : 'https://api.github.com';
const webBase =
  process.env.NODE_ENV === 'test' && process.env.GITHUB_TEST_WEB
    ? process.env.GITHUB_TEST_WEB
    : 'https://github.com';
export const githubConfigSchema = z.object({
  appId: z.number().int().positive(),
  slug: z.string().regex(/^[a-zA-Z0-9-]+$/),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(500),
  privateKey: z.string().min(1).max(20000),
});
type Configuration = z.infer<typeof githubConfigSchema>;
type Tokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  refreshExpiresAt?: number;
  error?: string;
};
const failure = (message: string, statusCode = 409) =>
  Object.assign(new Error(message), { statusCode });
export async function appConfiguration(): Promise<Configuration> {
  const [row] = await db.select().from(githubConfig).where(eq(githubConfig.id, 1));
  if (!row) throw failure('The instance owner needs to configure the GitHub App.');
  return JSON.parse(decrypt(row.encrypted));
}
function appJwt(c: Configuration) {
  const now = Math.floor(Date.now() / 1000);
  const payload = [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(c.appId) })).toString(
      'base64url',
    ),
  ].join('.');
  return (
    payload + '.' + sign('RSA-SHA256', Buffer.from(payload), c.privateKey).toString('base64url')
  );
}
async function githubRequest(
  route: string,
  token?: string,
  body?: unknown,
  oauth = false,
): Promise<any> {
  const response = await fetch((oauth ? webBase : apiBase) + route, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: {
      accept: 'application/json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok || value.error) {
    // Never include responses from token exchange or supplied secrets in errors.
    if (oauth)
      throw failure('GitHub authorization expired or was revoked. Reconnect your account.');
    const message =
      typeof value.message === 'string'
        ? value.message
            .slice(0, 600)
            .replace(/(?:gh[opsur]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[redacted]')
        : 'Request failed';
    throw failure(
      `GitHub ${response.status}: ${message}${response.status === 401 ? '. Reconnect your GitHub account.' : ''}`,
      response.status === 401 ? 409 : 403,
    );
  }
  return value;
}
async function pages(route: string, token: string, key?: string) {
  const values: any[] = [];
  for (let page = 1; page <= 100; page++) {
    const result = await githubRequest(
      `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      token,
    );
    const list = key ? result[key] : result;
    if (!Array.isArray(list)) throw failure('Unexpected GitHub response');
    values.push(...list);
    if (list.length < 100) return values;
  }
  throw failure('Too many GitHub results. Narrow your app installation to selected repositories.');
}
export async function userToken(userId: string) {
  return db
    .transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(githubConnections)
        .where(eq(githubConnections.userId, userId))
        .for('update');
      if (!row || row.revoked)
        throw failure(
          'Connect or reconnect your GitHub account to use this repository. You can still edit and commit locally.',
        );
      let tokens: Tokens = JSON.parse(decrypt(row.encrypted));
      if (row.expiresAt && row.expiresAt.getTime() < Date.now() + 60000) {
        if (
          !tokens.refresh_token ||
          (tokens.refreshExpiresAt && tokens.refreshExpiresAt < Date.now())
        )
          throw failure('GitHub authorization expired. Reconnect your account.');
        const [stored] = await tx.select().from(githubConfig).where(eq(githubConfig.id, 1));
        if (!stored) throw failure('The instance owner needs to configure the GitHub App.');
        const c: Configuration = JSON.parse(decrypt(stored.encrypted));
        tokens = await githubRequest(
          '/login/oauth/access_token',
          undefined,
          {
            client_id: c.clientId,
            client_secret: c.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token,
          },
          true,
        );
        if (!tokens.access_token)
          throw failure('GitHub authorization expired. Reconnect your account.');
        tokens.refreshExpiresAt = tokens.refresh_token_expires_in
          ? Date.now() + tokens.refresh_token_expires_in * 1000
          : undefined;
        await tx
          .update(githubConnections)
          .set({
            encrypted: encrypt(JSON.stringify(tokens)),
            expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
          })
          .where(eq(githubConnections.userId, userId));
      }
      return tokens.access_token;
    })
    .catch(async (e) => {
      if (/authorization expired|authorization.*revoked/i.test(e.message))
        await db
          .update(githubConnections)
          .set({ revoked: true })
          .where(eq(githubConnections.userId, userId));
      throw e;
    });
}
export async function installationsFor(userId: string) {
  const c = await appConfiguration();
  const token = await userToken(userId);
  const list = await pages('/user/installations', token, 'installations');
  return list
    .filter((i) => i.app_id === c.appId && !i.suspended_at)
    .map((i) => ({ id: i.id, account: i.account.login }));
}
export async function repositoriesFor(
  userId: string,
  installationId?: number,
): Promise<GitHubRepository[]> {
  if (!installationId) {
    const [row] = await db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.userId, userId));
    installationId = row?.installationId || undefined;
  }
  if (!installationId) throw failure('Select a GitHub App installation first.');
  if (!(await installationsFor(userId)).some((i) => i.id === installationId))
    throw failure(
      'This GitHub App installation is unavailable to your account. Reconnect or select another installation.',
    );
  const token = await userToken(userId);
  const list = await pages(
    `/user/installations/${installationId}/repositories`,
    token,
    'repositories',
  );
  // GitHub intersects installed repositories with repositories the acting user can access.
  return list
    .filter((r) => r.permissions?.pull !== false)
    .map((r) => ({
      id: r.id,
      fullName: r.full_name,
      cloneUrl: r.clone_url,
      installationId: installationId!,
      canPush: !!r.permissions?.push,
    }));
}
export async function validateRepository(
  userId: string,
  source: { repositoryId: number; installationId: number },
  push = false,
) {
  const repo = (await repositoriesFor(userId, source.installationId)).find(
    (r) => r.id === source.repositoryId,
  );
  if (!repo)
    throw failure(
      'Your GitHub account and app installation must both have access to this repository.',
      403,
    );
  const parsed = new URL(repo.cloneUrl);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(parsed.pathname)
  )
    throw failure('GitHub returned an invalid repository remote.');
  if (push && !repo.canPush)
    throw failure('Your GitHub account does not have push permission for this repository.', 403);
  return repo;
}
export async function githubIdentity(userId: string) {
  try {
    const user = await githubRequest('/user', await userToken(userId));
    return {
      name: user.name || user.login,
      email: `${user.id}+${user.login}@users.noreply.github.com`,
    };
  } catch {
    return null;
  }
}
export async function cloneGithub(project: typeof projects.$inferSelect) {
  if (!project.repository || project.repository.cloned) return;
  const source = project.repository;
  const repo = await validateRepository(source.userId, source);
  await bridge(project.id, '/git', 'POST', {
    action: 'clone',
    url: repo.cloneUrl,
    credential: { token: await userToken(source.userId), remote: repo.cloneUrl },
  });
  await db
    .update(projects)
    .set({ repository: { ...source, cloned: true } })
    .where(eq(projects.id, project.id));
}
async function createState(userId: string, kind: string) {
  await db.delete(githubStates).where(lt(githubStates.expiresAt, new Date()));
  const state = randomBytes(32).toString('hex');
  await db
    .insert(githubStates)
    .values({ hash: tokenHash(state), userId, kind, expiresAt: new Date(Date.now() + 10 * 60000) });
  return state;
}
async function consumeState(userId: string, kind: string, state: string) {
  const [record] = await db
    .delete(githubStates)
    .where(
      and(
        eq(githubStates.hash, tokenHash(state)),
        eq(githubStates.userId, userId),
        eq(githubStates.kind, kind),
        gt(githubStates.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!record)
    throw failure(
      'Authorization state expired, was already used, or belongs to another account.',
      403,
    );
}
export async function githubRoutes(app: FastifyInstance) {
  app.get('/api/github/config', async (req) => {
    await requireOwner(req);
    try {
      const c = await appConfiguration();
      return { configured: true, appId: c.appId, slug: c.slug, clientId: c.clientId };
    } catch {
      return { configured: false };
    }
  });
  app.put('/api/github/config', async (req) => {
    await requireOwner(req);
    const c = githubConfigSchema.parse(req.body);
    const key = createPrivateKey(c.privateKey);
    if (key.asymmetricKeyType !== 'rsa') throw failure('Use the GitHub App RSA private key.');
    const appInfo = await githubRequest('/app', appJwt(c));
    if (appInfo.id !== c.appId || appInfo.slug !== c.slug)
      throw failure('App ID, slug, and private key do not match.');
    if (
      appInfo.permissions?.contents !== 'write' ||
      appInfo.permissions?.metadata !== 'read' ||
      appInfo.permissions?.workflows ||
      appInfo.permissions?.pull_requests
    )
      throw failure(
        'Configure Contents read/write and Metadata read, without Workflows or Pull requests permissions.',
      );
    await db.transaction(async (tx) => {
      await tx
        .insert(githubConfig)
        .values({ id: 1, encrypted: encrypt(JSON.stringify(c)) })
        .onConflictDoUpdate({
          target: githubConfig.id,
          set: { encrypted: encrypt(JSON.stringify(c)) },
        });
      await tx.delete(githubConnections);
      await tx.delete(githubStates);
    });
    return { ok: true };
  });
  app.post('/api/github/manifest', async (req) => {
    const user = await requireOwner(req);
    const b = z
      .object({
        organization: z
          .string()
          .regex(/^[a-zA-Z0-9-]*$/)
          .default(''),
        name: z.string().min(1).max(80),
      })
      .parse(req.body);
    const state = await createState(user.id, 'manifest');
    const callback = new URL('/api/github/callback/manifest', config.publicUrl).href;
    return {
      action: `${webBase}${b.organization ? '/organizations/' + b.organization + '/settings/apps/new' : '/settings/apps/new'}?state=${state}`,
      manifest: {
        name: b.name,
        url: config.publicUrl,
        public: true,
        redirect_url: callback,
        callback_urls: [new URL('/api/github/callback/authorize', config.publicUrl).href],
        request_oauth_on_install: false,
        default_permissions: { contents: 'write', metadata: 'read' },
        default_events: [],
      },
    };
  });
  app.get('/api/github/connection', async (req) => {
    const user = await requireUser(req);
    const [row] = await db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.userId, user.id));
    let configured = true,
      slug = '';
    try {
      slug = (await appConfiguration()).slug;
    } catch {
      configured = false;
    }
    return {
      configured,
      slug,
      connected: !!row && !row.revoked,
      login: row?.login,
      installationId: row?.installationId,
    };
  });
  app.post('/api/github/authorize', async (req) => {
    const user = await requireUser(req),
      c = await appConfiguration();
    const state = await createState(user.id, 'authorize');
    return {
      url: `${webBase}/login/oauth/authorize?${new URLSearchParams({ client_id: c.clientId, redirect_uri: new URL('/api/github/callback/authorize', config.publicUrl).href, state })}`,
    };
  });
  app.get('/api/github/callback/:kind', async (req, reply) => {
    const kind = z.enum(['authorize', 'manifest']).parse((req.params as { kind: string }).kind);
    const q = z
      .object({
        code: z
          .string()
          .regex(/^[A-Za-z0-9_-]+$/)
          .max(300),
        state: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(req.query);
    // This landing GET needs no session. After it becomes the top-level same-origin page,
    // the authenticated completion POST receives the existing SameSite=Strict cookie.
    return reply
      .type('text/html')
      .header(
        'content-security-policy',
        "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      )
      .send(
        `<!doctype html><meta charset="utf-8"><title>Connect GitHub</title><p id="status">Completing GitHub connection…</p><script>history.replaceState(null,'','/github');fetch('/api/github/complete/${kind}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(q)})}).then(async r=>{if(!r.ok)throw new Error((await r.json()).error);location.replace('/github')}).catch(e=>{document.getElementById('status').textContent=e.message+' Return to Repellet and sign in to reconnect.'})</script>`,
      );
  });
  app.post('/api/github/complete/:kind', async (req) => {
    const kind = z.enum(['authorize', 'manifest']).parse((req.params as { kind: string }).kind);
    const user = kind === 'manifest' ? await requireOwner(req) : await requireUser(req);
    const b = z
      .object({
        code: z
          .string()
          .regex(/^[A-Za-z0-9_-]+$/)
          .max(300),
        state: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(req.body);
    await consumeState(user.id, kind, b.state);
    if (kind === 'manifest') {
      const appInfo = await githubRequest(`/app-manifests/${b.code}/conversions`, undefined, {});
      const c = githubConfigSchema.parse({
        appId: appInfo.id,
        slug: appInfo.slug,
        clientId: appInfo.client_id,
        clientSecret: appInfo.client_secret,
        privateKey: appInfo.pem,
      });
      await db.transaction(async (tx) => {
        await tx
          .insert(githubConfig)
          .values({ id: 1, encrypted: encrypt(JSON.stringify(c)) })
          .onConflictDoUpdate({
            target: githubConfig.id,
            set: { encrypted: encrypt(JSON.stringify(c)) },
          });
        await tx.delete(githubConnections);
      });
    } else {
      const c = await appConfiguration();
      const tokens: Tokens = await githubRequest(
        '/login/oauth/access_token',
        undefined,
        {
          client_id: c.clientId,
          client_secret: c.clientSecret,
          code: b.code,
          redirect_uri: new URL('/api/github/callback/authorize', config.publicUrl).href,
        },
        true,
      );
      if (!tokens.access_token) throw failure('GitHub did not return an access token. Reconnect.');
      const identity = await githubRequest('/user', tokens.access_token);
      tokens.refreshExpiresAt = tokens.refresh_token_expires_in
        ? Date.now() + tokens.refresh_token_expires_in * 1000
        : undefined;
      const values = {
        userId: user.id,
        encrypted: encrypt(JSON.stringify(tokens)),
        login: identity.login,
        githubId: identity.id,
        installationId: null,
        revoked: false,
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
      };
      await db
        .insert(githubConnections)
        .values(values)
        .onConflictDoUpdate({ target: githubConnections.userId, set: values });
    }
    return { ok: true };
  });
  app.delete('/api/github/connection', async (req) => {
    const user = await requireUser(req);
    await db.transaction(async (tx) => {
      await tx.delete(githubConnections).where(eq(githubConnections.userId, user.id));
      await tx.delete(githubStates).where(eq(githubStates.userId, user.id));
    });
    return { ok: true };
  });
  app.get('/api/github/installations', async (req) =>
    installationsFor((await requireUser(req)).id),
  );
  app.put('/api/github/installation', async (req) => {
    const user = await requireUser(req),
      b = z.object({ installationId: z.number().int().positive() }).parse(req.body);
    if (!(await installationsFor(user.id)).some((i) => i.id === b.installationId))
      throw failure('Installation is not available to your account.', 403);
    await db.update(githubConnections).set(b).where(eq(githubConnections.userId, user.id));
    return { ok: true };
  });
  app.get('/api/github/repositories', async (req) => repositoriesFor((await requireUser(req)).id));
  app.put('/api/projects/:id/repository', async (req) => {
    const p = await access(req, 'manage'),
      user = await requireUser(req),
      b = githubSourceSchema.parse(req.body);
    const repo = await validateRepository(user.id, b);
    return serialize(p.id, async () => {
      const remote = await bridge<{ url: string }>(p.id, '/git/remote');
      if (remote.url !== repo.cloneUrl)
        throw failure(
          'The origin remote must exactly match the selected GitHub HTTPS remote. Set it in the terminal first.',
        );
      const repository: GitHubSource = {
        repositoryId: repo.id,
        installationId: b.installationId,
        fullName: repo.fullName,
        cloneUrl: repo.cloneUrl,
        userId: user.id,
        cloned: true,
      };
      await db.update(projects).set({ repository }).where(eq(projects.id, p.id));
      return { ok: true };
    });
  });
  app.get('/api/github/repositories/:repositoryId/suggestion', async (req) => {
    const user = await requireUser(req),
      b = z.object({ installationId: z.coerce.number().int().positive() }).parse(req.query);
    const repositoryId = z.coerce
      .number()
      .int()
      .positive()
      .parse((req.params as { repositoryId: string }).repositoryId);
    const repo = await validateRepository(user.id, { ...b, repositoryId }),
      token = await userToken(user.id);
    const manifests: Record<string, string> = {};
    const entries = await githubRequest(`/repos/${repo.fullName}/contents`, token);
    for (const name of [
      'package.json',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'requirements.txt',
      'go.mod',
      'Cargo.toml',
      'main.py',
      'app.py',
      'main.go',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock',
      'bun.lockb',
    ]) {
      if (
        !entries.some((e: any) => e.name === name && e.type === 'file' && e.size < 2 * 1024 * 1024)
      )
        continue;
      const result = await githubRequest(`/repos/${repo.fullName}/contents/${name}`, token);
      if (result.encoding === 'base64')
        manifests[name] = Buffer.from(result.content, 'base64').toString('utf8');
    }
    const { suggestSetup } = await import('@repellet/shared');
    return suggestSetup(manifests, '', new URL(config.publicUrl).hostname);
  });
}
