import Fastify from 'fastify';
export async function fakeGitHub() {
  const app = Fastify();
  app.get('/login/oauth/authorize', async (req, reply) => {
    const q = req.query;
    const destination = new URL(q.redirect_uri);
    destination.searchParams.set('state', q.state);
    destination.searchParams.set('code', q.identity === 'readonly' ? 'readonly' : 'writer');
    return reply.redirect(destination.href);
  });
  app.post('/login/oauth/access_token', async (req) => ({
    access_token: req.body.code === 'readonly' ? 'read-user' : 'write-user',
    refresh_token: 'fake-refresh',
    expires_in: 28800,
    refresh_token_expires_in: 15811200,
  }));
  app.get('/app', async () => ({
    id: 123,
    slug: 'repellet-browser-test',
    permissions: { contents: 'write', metadata: 'read' },
  }));
  app.get('/user', async (req) => ({
    id: req.headers.authorization === 'Bearer read-user' ? 2 : 1,
    login: req.headers.authorization === 'Bearer read-user' ? 'reader' : 'writer',
    name: 'GitHub Browser User',
  }));
  app.get('/user/installations', async () => ({
    installations: [{ id: 55, app_id: 123, account: { login: 'test-org' } }],
  }));
  app.get('/user/installations/55/repositories', async (req) => ({
    repositories: [
      {
        id: 42,
        full_name: 'test-org/private',
        clone_url: 'https://github.com/test-org/private.git',
        permissions: { pull: true, push: req.headers.authorization === 'Bearer write-user' },
      },
    ],
  }));
  return app;
}
