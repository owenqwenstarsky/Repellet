import { test, expect, type Page } from '@playwright/test';
import { WebSocket } from 'ws';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import tar from 'tar-stream';
async function login(page: Page, username = 'e2e-owner') {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill('repellet-e2e-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}
async function newFile(page: Page, path: string, content: string) {
  const files = page.getByRole('button', { name: 'Files', exact: true });
  if ((await files.getAttribute('aria-pressed')) !== 'true') await files.click();
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await page.getByLabel('Workspace path').fill(path);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.editor-tab.active')).toContainText(path.split('/').pop()!);
  const editor = page.locator('.retained-editor:visible .monaco-editor textarea').first();
  await expect(editor).toBeAttached();
  await expect(
    page.locator('.retained-editor:visible .connection-indicator.connected'),
  ).toBeVisible();
  await editor.focus();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate((text) => navigator.clipboard.writeText(text), content);
  await page.keyboard.press('ControlOrMeta+V');
  await expect
    .poll(async () => {
      const r = await page.request.get(
        `/api/projects/${page.url().split('/').pop()}/file?path=${encodeURIComponent(path)}`,
      );
      return r.ok() ? (await r.json()).content : '';
    })
    .toBe(content);
}
test('owner setup, IDE workflows, private previews, collaboration, and viewers', async ({
  page,
  browser,
}) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible();
  await page.getByLabel('Setup token').fill('repellet-e2e-setup-token');
  await page.getByLabel('Display name').fill('Workspace Owner');
  await page.getByLabel('Username', { exact: true }).fill('e2e-owner');
  await page.getByLabel('Password', { exact: true }).fill('repellet-e2e-password-123');
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.screenshot({ path: '.cache/dashboard.png', fullPage: true });
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Browser workspace');
  await page
    .getByLabel('Description', { exact: false })
    .fill('A real collaborative development environment');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(
    page.locator('.workspace-header').getByRole('button', { name: 'Run', exact: true }),
  ).toBeEnabled({ timeout: 300000 });
  const id = page.url().split('/').pop()!;
  await newFile(
    page,
    'server.mjs',
    "import http from 'node:http';\nhttp.createServer((req, res) => {\n  res.setHeader('Content-Type', 'text/html');\n  res.end('<h1>Repellet preview works</h1>');\n}).listen(3000, '0.0.0.0');\n",
  );
  // Native directory uploads preserve nested paths, and folder downloads return an archive.
  await page
    .locator('input[webkitdirectory]')
    .setInputFiles(path.resolve('tests/fixtures/upload-folder'));
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/projects/${id}/file?path=upload-folder/nested/note.txt`,
      );
      return response.ok() ? (await response.json()).content : '';
    })
    .toBe('Nested folders survive upload.\n');
  const download = await page.request.get(`/api/projects/${id}/files/download?path=upload-folder`);
  expect(download.headers()['content-type']).toContain('application/x-tar');
  const extract = tar.extract();
  const entries = new Map<string, string>();
  const unpacked = new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      let content = '';
      stream.on('data', (chunk) => (content += String(chunk)));
      stream.on('end', () => {
        entries.set(header.name, content);
        next();
      });
      stream.on('error', reject);
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
  });
  extract.end(await download.body());
  await unpacked;
  expect(entries.get('nested/note.txt')).toBe('Nested folders survive upload.\n');
  await page.getByRole('button', { name: 'Project settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Run & setup' }).click();
  await page.getByLabel('Run command').fill('node server.mjs');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.locator('.workspace-header').getByRole('button', { name: 'Run', exact: true }).click();
  await expect
    .poll(
      async () => {
        const url = await page.getByLabel('Preview URL').inputValue();
        const response = await page.request.get(url).catch(() => null);
        return response?.status();
      },
      { timeout: 30000 },
    )
    .toBe(200);
  await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
  await expect(
    page.frameLocator('iframe[title="Project preview"]').getByText('Repellet preview works'),
  ).toBeVisible();
  const preview = await page.getByLabel('Preview URL').inputValue();
  const anonymous = await browser.newContext();
  const denied = await anonymous.request.get(preview);
  expect(denied.status()).toBe(403);
  await anonymous.close();
  // Two real browser sessions edit one document.
  const origin = { origin: 'http://localhost:3315' };
  const created = await page.request.post('/api/admin/users', {
    headers: origin,
    data: {
      username: 'e2e-editor',
      displayName: 'Collaborator',
      password: 'repellet-e2e-password-123',
    },
  });
  expect(created.status()).toBe(201);
  const editorUser = await created.json();
  expect(
    (
      await page.request.put(`/api/projects/${id}/members`, {
        headers: origin,
        data: { userId: editorUser.id, role: 'editor' },
      })
    ).ok(),
  ).toBe(true);
  await newFile(page, 'notes.txt', 'Hello team\n');
  const collaborator = await browser.newContext();
  const other = await collaborator.newPage();
  await login(other, 'e2e-editor');
  await other.getByRole('button', { name: 'Open Browser workspace', exact: true }).click();
  await expect(
    other.locator('.workspace-header').getByRole('button', { name: 'Run', exact: true }),
  ).toBeEnabled();
  await other.locator('.file-row').filter({ hasText: 'notes.txt' }).click();
  await expect(
    other.locator('.retained-editor:visible .connection-indicator.connected'),
  ).toBeVisible();
  const input = other.locator('.retained-editor:visible .monaco-editor textarea').first();
  await input.focus();
  await other.keyboard.press('ControlOrMeta+End');
  await other.keyboard.insertText('Edited together\n');
  await expect(page.locator('.retained-editor:visible .view-lines')).toContainText(
    'Edited together',
  );
  await expect(page.locator('.collaborators [title="Collaborator"]')).toBeVisible();
  await expect
    .poll(() => page.locator('.retained-editor:visible .yRemoteSelectionHead').count())
    .toBeGreaterThan(0);
  // Each collaborator restores only their own tabs and panels.
  await other.getByRole('button', { name: 'Toggle preview', exact: true }).click();
  await other.reload();
  await expect(other.locator('.editor-tab.active')).toContainText('notes.txt');
  await expect(other.locator('.preview-pane')).toHaveCount(0);
  await expect(page.locator('.preview-pane')).toBeVisible();
  // Terminal edits that race autosave produce a visible conflict.
  await newFile(page, 'conflict.txt', 'initial\n');
  const terminals = await (await page.request.get(`/api/projects/${id}/terminals`)).json();
  const term = terminals.find((t: any) => !t.isRun && t.alive);
  const cookies = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const shell = new WebSocket(
    `ws://localhost:3315/ws/projects/${id}/channel?path=${encodeURIComponent(`/terminals/${term.id}/connect`)}`,
    { headers: { origin: 'http://localhost:3315', cookie: cookies } },
  );
  await new Promise<void>((resolve, reject) => {
    shell.once('message', () => resolve());
    shell.once('error', reject);
  });
  await page.locator('.retained-editor:visible .monaco-editor textarea').first().focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('editor change\n');
  shell.send(
    JSON.stringify({
      type: 'input',
      data: "printf 'external change\\n' > /workspace/conflict.txt\r",
    }),
  );
  await expect(page.getByText('This file changed on disk. Autosave is paused.')).toBeVisible();
  await page.getByRole('button', { name: 'Reload from disk', exact: true }).click();
  await expect(page.locator('.retained-editor:visible .view-lines')).toContainText(
    'external change',
  );
  shell.close();
  await page.screenshot({ path: '.cache/workspace.png', fullPage: true });
  // Concurrent renames serialize, and accepted content survives the winning rename.
  const renames = await Promise.all(
    ['renamed-a.txt', 'renamed-b.txt'].map((to) =>
      page.request.post(`/api/projects/${id}/files/move`, {
        headers: origin,
        data: { from: 'conflict.txt', to },
      }),
    ),
  );
  expect(renames.filter((r) => r.ok())).toHaveLength(1);
  const renamed = renames[0]!.ok() ? 'renamed-a.txt' : 'renamed-b.txt';
  expect(
    (await (await page.request.get(`/api/projects/${id}/file?path=${renamed}`)).json()).content,
  ).toBe('external change\n');
  // Downgrade the collaborator and verify both UI and server enforcement.
  expect(
    (
      await page.request.put(`/api/projects/${id}/members`, {
        headers: origin,
        data: { userId: editorUser.id, role: 'viewer' },
      })
    ).ok(),
  ).toBe(true);
  await other.reload();
  await expect(other.getByText('View only', { exact: true })).toBeVisible();
  expect(
    await other
      .locator('.workspace-header')
      .getByRole('button', { name: 'Run', exact: true })
      .count(),
  ).toBe(0);
  expect(
    (
      await other.request.post(`/api/projects/${id}/files/create`, {
        headers: origin,
        data: { path: 'forbidden.txt', kind: 'file' },
      })
    ).status(),
  ).toBe(403);
  await collaborator.close();
  expect(consoleErrors).toEqual([]);
});

for (const starter of [
  { id: 'react-vite', file: 'src/App.tsx', changed: 'React edit is live' },
  { id: 'python-fastapi', file: 'main.py', changed: 'FastAPI edit is live' },
]) {
  test(`${starter.id} prepares, runs, edits, and previews without terminal commands`, async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.getByLabel('Project name', { exact: true }).fill(starter.id);
    await page.getByLabel('Project source', { exact: true }).selectOption(starter.id);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await expect(page.getByText('Ready to run', { exact: true })).toBeVisible({ timeout: 300000 });
    const id = page.url().split('/').pop()!;
    const before = await (await page.request.get(`/api/projects/${id}/terminals`)).json();
    expect(before.some((t: any) => t.isRun && t.alive)).toBe(false);
    await expect(page.locator('.editor-tab.active')).toContainText(starter.file.split('/').pop()!);
    await page
      .locator('.workspace-header')
      .getByRole('button', { name: 'Run', exact: true })
      .click();
    await expect(
      page
        .frameLocator('iframe[title="Project preview"]')
        .getByRole('heading', { name: 'Hello from Repellet' }),
    ).toBeVisible();
    const original = (
      await (
        await page.request.get(`/api/projects/${id}/file?path=${encodeURIComponent(starter.file)}`)
      ).json()
    ).content;
    const content = original.replace('Hello from Repellet', starter.changed);
    await expect(
      page.locator('.retained-editor:visible .connection-indicator.connected'),
    ).toBeVisible();
    const input = page.locator('.retained-editor:visible .monaco-editor textarea').first();
    await input.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate((text) => navigator.clipboard.writeText(text), content);
    await page.keyboard.press('ControlOrMeta+V');
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(
                `/api/projects/${id}/file?path=${encodeURIComponent(starter.file)}`,
              )
            ).json()
          ).content,
      )
      .toBe(content);
    if (starter.id === 'python-fastapi') {
      await page.waitForTimeout(1200);
      await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
    }
    await expect(
      page
        .frameLocator('iframe[title="Project preview"]')
        .getByRole('heading', { name: starter.changed }),
    ).toBeVisible();
    await page.screenshot({ path: `.cache/${starter.id}.png`, fullPage: true });
    const jobReport = await (await page.request.get(`/api/projects/${id}/preparation`)).json();
    let timingReport: unknown[] = [];
    try {
      timingReport = JSON.parse(await readFile('.cache/workflow-timings.json', 'utf8'));
    } catch {}
    timingReport.push({
      starter: starter.id,
      jobs: jobReport.jobs.map((j: any) => ({
        kind: j.kind,
        state: j.state,
        steps: j.steps,
        durationMs: j.finishedAt
          ? Date.parse(j.finishedAt) - Date.parse(j.startedAt || j.createdAt)
          : null,
      })),
    });
    await writeFile('.cache/workflow-timings.json', JSON.stringify(timingReport, null, 2));
    // Run replacement must wait for the previous server to release its fixed port.
    await page
      .locator('.workspace-header')
      .getByRole('button', { name: 'Run', exact: true })
      .click();
    await expect(
      page
        .frameLocator('iframe[title="Project preview"]')
        .getByRole('heading', { name: starter.changed }),
    ).toBeVisible();
    await page.reload();
    await expect(page.locator('.editor-tab.active')).toContainText(starter.file.split('/').pop()!);
    await expect(
      page
        .frameLocator('iframe[title="Project preview"]')
        .getByRole('heading', { name: starter.changed }),
    ).toBeVisible();
    expect(
      (await (await page.request.get(`/api/projects/${id}/preparation`)).json()).jobs.filter(
        (j: any) => j.kind === 'prepare' && j.state === 'succeeded',
      ),
    ).toHaveLength(1);
    if (starter.id === 'react-vite') {
      const origin = { origin: 'http://localhost:3315' };
      for (const path of ['src/one.ts', 'src/two.ts']) {
        expect(
          (
            await page.request.post(`/api/projects/${id}/files/upload`, {
              headers: origin,
              data: {
                path,
                data: Buffer.from(`export const value: string = 123;\n`).toString('base64'),
              },
            })
          ).ok(),
        ).toBe(true);
        await page.keyboard.press('ControlOrMeta+P');
        await page.getByLabel('Search file paths').fill(path);
        await expect(page.getByRole('option', { name: path, exact: true })).toBeVisible();
        await page.getByLabel('Search file paths').press('Enter');
        await expect(page.locator('.editor-tab.active')).toContainText(path.split('/').pop()!);
      }
      await page.getByRole('button', { name: 'Problems', exact: true }).click();
      await expect(page.locator('.problems-pane')).toContainText('src/one.ts');
      await expect(page.locator('.problems-pane')).toContainText('src/two.ts');
      await page
        .locator('.problems-pane section')
        .filter({ hasText: 'src/one.ts' })
        .getByRole('button')
        .first()
        .click();
      await expect(page.locator('.editor-tab.active')).toContainText('one.ts');
      await page.getByRole('button', { name: 'Toggle preview', exact: true }).click();
      await page.reload();
      await expect(page.locator('.editor-tab.active')).toContainText('one.ts');
      await expect(page.locator('.preview-pane')).toHaveCount(0);
      await expect(page.locator('.problems-pane')).toContainText('src/two.ts');
      const moved = await page.request.post(`/api/projects/${id}/files/move`, {
        headers: origin,
        data: { from: 'src/one.ts', to: 'src/renamed.ts' },
      });
      expect(moved.ok()).toBe(true);
      await expect(page.locator('.editor-tab.active')).toContainText('renamed.ts');
      expect(
        (
          await page.request.post(`/api/projects/${id}/files/delete`, {
            headers: origin,
            data: { path: 'src/two.ts' },
          })
        ).ok(),
      ).toBe(true);
      await expect(page.locator('.editor-tab').filter({ hasText: 'two.ts' })).toHaveCount(0);
      await expect(page.locator('.problems-pane')).not.toContainText('src/two.ts');
      // Deleting the active file should activate a remaining tab and keep its editor connected.
      expect(
        (
          await page.request.post(`/api/projects/${id}/files/delete`, {
            headers: origin,
            data: { path: 'src/renamed.ts' },
          })
        ).ok(),
      ).toBe(true);
      await expect(page.locator('.editor-tab.active')).toContainText('App.tsx');
      await expect(
        page.locator('.retained-editor:visible .connection-indicator.connected'),
      ).toBeVisible();
    }
    expect(
      (
        await page.request.post(`/api/projects/${id}/stop`, {
          headers: { origin: 'http://localhost:3315' },
        })
      ).ok(),
    ).toBe(true);
  });
}

test('GitHub redirects complete with Strict cookies and member repository permissions stay independent', async ({
  page,
  browser,
}) => {
  await login(page);
  const connect = async (page: Page, identity: string) => {
    const response = await page.request.post('/api/github/authorize', {
      headers: { origin: 'http://localhost:3315' },
    });
    const { url } = await response.json();
    await page.goto(url + '&identity=' + identity);
    await expect(
      page.getByText(`@${identity === 'readonly' ? 'reader' : 'writer'}`, {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByLabel('App installation', { exact: true }).selectOption('55');
    await expect
      .poll(
        async () =>
          (await (await page.request.get('/api/github/connection')).json()).installationId,
      )
      .toBe(55);
  };
  await connect(page, 'writer');
  const repos = await (await page.request.get('/api/github/repositories')).json();
  expect(repos).toEqual([
    {
      id: 42,
      fullName: 'test-org/private',
      cloneUrl: 'https://github.com/test-org/private.git',
      installationId: 55,
      canPush: true,
    },
  ]);
  const context = await browser.newContext(),
    other = await context.newPage();
  await login(other, 'e2e-editor');
  await connect(other, 'readonly');
  expect((await (await other.request.get('/api/github/repositories')).json())[0].canPush).toBe(
    false,
  );
  expect((await (await page.request.get('/api/github/connection')).json()).login).toBe('writer');
  await context.close();
});
