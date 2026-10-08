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
  await page.getByRole('tab', { name: 'Run' }).click();
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
  const origin = { origin: `http://localhost:${process.env.REPELLET_E2E_PORT || 3315}` };
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
    `ws://localhost:${process.env.REPELLET_E2E_PORT || 3315}/ws/projects/${id}/channel?path=${encodeURIComponent(`/terminals/${term.id}/connect`)}`,
    {
      headers: {
        origin: `http://localhost:${process.env.REPELLET_E2E_PORT || 3315}`,
        cookie: cookies,
      },
    },
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
  { id: 'static-html', file: 'index.html', changed: 'Static edit is live' },
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
    await expect(page.getByRole('button', { name: 'Toggle bottom panel' })).toBeVisible({
      timeout: 300000,
    });
    if (!(await page.getByRole('tab', { name: 'Preparation Logs' }).isVisible()))
      await page.getByRole('button', { name: 'Toggle bottom panel' }).click();
    await page.getByRole('tab', { name: 'Preparation Logs' }).click();
    await expect(
      page
        .getByRole('tabpanel', { name: 'Preparation Logs' })
        .getByText('Ready to run', { exact: true }),
    ).toBeVisible({ timeout: 300000 });
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
    const previousGeneration = (await (await page.request.get(`/api/projects/${id}`)).json())
      .appStatus.generation;
    const restarted = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/projects/${id}/run`) &&
        response.request().method() === 'POST',
    );
    await page
      .locator('.workspace-header')
      .getByRole('button', { name: 'Run', exact: true })
      .click();
    expect((await restarted).ok()).toBe(true);
    await expect
      .poll(async () => {
        const { appStatus } = await (await page.request.get(`/api/projects/${id}`)).json();
        return appStatus.status === 'available' && appStatus.generation !== previousGeneration;
      })
      .toBe(true);
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
    if (starter.id === 'static-html') {
      const origin = { origin: 'http://localhost:3315' };
      const preview = await page.getByLabel('Preview URL').inputValue();
      const standalone = await page.context().newPage();
      await standalone.goto(preview);
      await standalone.getByRole('button', { name: 'Clicked 0 times' }).click();
      await expect(
        standalone.getByRole('button', { name: 'Clicked 1 time', exact: true }),
      ).toBeVisible();
      const anonymous = await page.context().browser()!.newContext();
      expect((await anonymous.request.get(preview)).status()).toBe(403);
      await anonymous.close();

      const viewerResult = await page.request.post('/api/admin/users', {
        headers: origin,
        data: {
          username: 'static-viewer',
          displayName: 'Static Viewer',
          password: 'repellet-e2e-password-123',
        },
      });
      expect(viewerResult.ok()).toBe(true);
      const viewer = await viewerResult.json();
      expect(
        (
          await page.request.put(`/api/projects/${id}/members`, {
            headers: origin,
            data: { userId: viewer.id, role: 'viewer' },
          })
        ).ok(),
      ).toBe(true);
      const context = await page.context().browser()!.newContext();
      await context.request.post('/api/auth/login', {
        headers: origin,
        data: { username: 'static-viewer', password: 'repellet-e2e-password-123' },
      });
      expect((await context.request.get(preview)).status()).toBe(200);
      const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
      const reload = new WebSocket(preview.replace(/^http/, 'ws') + '/__repellet_static__/reload', {
        headers: { origin: new URL(preview).origin, cookie },
      });
      await new Promise<void>((resolve, reject) => {
        reload.once('open', resolve);
        reload.once('error', reject);
      });
      const reloadMessage = new Promise<string>((resolve) =>
        reload.once('message', (data) => resolve(String(data))),
      );
      const update = async (filename: string, addition: string) => {
        const file = await (
          await page.request.get(`/api/projects/${id}/file?path=${filename}`)
        ).json();
        await page.locator('.file-row').filter({ hasText: filename }).click();
        await expect(page.locator('.editor-tab.active')).toContainText(filename);
        await expect(
          page.locator('.retained-editor:visible .connection-indicator.connected'),
        ).toBeVisible();
        await page.locator('.retained-editor:visible .monaco-editor textarea').first().focus();
        await page.keyboard.press('ControlOrMeta+A');
        await page.evaluate(
          (content) => navigator.clipboard.writeText(content),
          file.content + addition,
        );
        await page.keyboard.press('ControlOrMeta+V');
        await expect
          .poll(
            async () =>
              (await (await page.request.get(`/api/projects/${id}/file?path=${filename}`)).json())
                .content,
          )
          .toBe(file.content + addition);
      };
      await update('style.css', '\nh1 { color: rgb(19, 45, 67); }\n');
      expect(await reloadMessage).toBe('reload');
      await expect(
        page.frameLocator('iframe[title="Project preview"]').getByRole('heading'),
      ).toHaveCSS('color', 'rgb(19, 45, 67)');
      await expect(standalone.getByRole('heading')).toHaveCSS('color', 'rgb(19, 45, 67)');
      await update(
        'script.js',
        "\ndocument.querySelector('#counter').textContent = 'JavaScript edit is live';\n",
      );
      await expect(
        page
          .frameLocator('iframe[title="Project preview"]')
          .getByRole('button', { name: 'JavaScript edit is live' }),
      ).toBeVisible();
      await expect(
        standalone.getByRole('button', { name: 'JavaScript edit is live' }),
      ).toBeVisible();
      const closed = new Promise<void>((resolve) => reload.once('close', () => resolve()));
      expect(
        (
          await page.request.delete(`/api/projects/${id}/members/${viewer.id}`, { headers: origin })
        ).ok(),
      ).toBe(true);
      await closed;
      expect((await context.request.get(preview)).status()).toBe(403);
      await context.close();

      // The open standalone preview must reconnect when the app process is replaced.
      const beforeRestart = await standalone.evaluate(() => performance.timeOrigin);
      expect(
        (await page.request.post(`/api/projects/${id}/run/stop`, { headers: origin })).ok(),
      ).toBe(true);
      expect((await page.request.post(`/api/projects/${id}/run`, { headers: origin })).ok()).toBe(
        true,
      );
      await expect
        .poll(async () => {
          try {
            return await standalone.evaluate(() => performance.timeOrigin);
          } catch {
            return beforeRestart;
          }
        })
        .toBeGreaterThan(beforeRestart);
      await expect(
        standalone.getByRole('button', { name: 'JavaScript edit is live' }),
      ).toBeVisible();
      await standalone.close();
      expect((await page.request.post(`/api/projects/${id}/stop`, { headers: origin })).ok()).toBe(
        true,
      );
      expect((await page.request.post(`/api/projects/${id}/open`, { headers: origin })).ok()).toBe(
        true,
      );
      await expect
        .poll(async () => (await (await page.request.get(`/api/projects/${id}`)).json()).state)
        .toBe('running');
      expect((await page.request.post(`/api/projects/${id}/run`, { headers: origin })).ok()).toBe(
        true,
      );
      await page.reload();
      await expect(
        page
          .frameLocator('iframe[title="Project preview"]')
          .getByRole('heading', { name: starter.changed }),
      ).toBeVisible();
      expect(
        (await (await page.request.get(`/api/projects/${id}/preparation`)).json()).jobs.filter(
          (j: any) => j.kind === 'prepare',
        ),
      ).toHaveLength(1);
    }
    if (starter.id === 'react-vite') {
      const origin = { origin: `http://localhost:${process.env.REPELLET_E2E_PORT || 3315}` };
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
          headers: { origin: `http://localhost:${process.env.REPELLET_E2E_PORT || 3315}` },
        })
      ).ok(),
    ).toBe(true);
  });
}

test('an uploaded static site applies suggestions and serves only its selected subdirectory', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Imported static site');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}$/);
  const id = page.url().split('/').pop()!;
  await expect
    .poll(async () => (await (await page.request.get(`/api/projects/${id}`)).json()).state)
    .toBe('running');
  const origin = { origin: 'http://localhost:3315' };
  for (const [filename, content] of Object.entries({
    'site/index.html':
      '<h1>Imported static site</h1><script type="module" src="./script.js"></script>',
    'site/script.js': "document.querySelector('h1').textContent = 'Imported JavaScript works';",
    'site/nested/index.html': '<h1>Another page</h1>',
    'private.txt': 'outside the selected site folder',
  })) {
    expect(
      (
        await page.request.post(`/api/projects/${id}/files/upload`, {
          headers: origin,
          data: { path: filename, data: Buffer.from(content).toString('base64') },
        })
      ).ok(),
    ).toBe(true);
  }
  const suggestion = await (
    await page.request.post(`/api/projects/${id}/setup/suggest`, {
      headers: origin,
      data: { cwd: 'site' },
    })
  ).json();
  expect(suggestion.setupCommand).toBe('');
  expect(suggestion.runConfig.cwd).toBe('site');
  expect(suggestion.runConfig.command).toContain('static-server.js');
  expect(
    (
      await page.request.put(`/api/projects/${id}/setup`, {
        headers: origin,
        data: {
          setupCommand: suggestion.setupCommand,
          runConfig: suggestion.runConfig,
          confirmed: true,
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (await (await page.request.get(`/api/projects/${id}/terminals`)).json()).some(
      (t: any) => t.isRun && t.alive,
    ),
  ).toBe(false);
  expect((await page.request.post(`/api/projects/${id}/run`, { headers: origin })).ok()).toBe(true);
  await expect(
    page
      .frameLocator('iframe[title="Project preview"]')
      .getByRole('heading', { name: 'Imported JavaScript works' }),
  ).toBeVisible();
  const preview = await page.getByLabel('Preview URL').inputValue();
  expect((await page.request.get(preview + '/private.txt')).status()).toBe(404);
  const nested = await page.request.get(preview + '/nested/');
  expect(nested.status()).toBe(200);
  expect(await nested.text()).toContain('Another page');
  expect((await page.request.post(`/api/projects/${id}/stop`, { headers: origin })).ok()).toBe(
    true,
  );
});

test('GitHub redirects complete with Strict cookies and member repository permissions stay independent', async ({
  page,
  browser,
}) => {
  await login(page);
  const connect = async (page: Page, identity: string) => {
    const response = await page.request.post('/api/github/authorize', {
      headers: { origin: `http://localhost:${process.env.REPELLET_E2E_PORT || 3315}` },
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

test('owner Codex settings, streamed tools, threads, steering, interruption, and reconnect', async ({
  page,
  browser,
}) => {
  await login(page);
  const { providerUrl } = JSON.parse(await readFile('.cache/e2e.json', 'utf8'));
  await page.getByRole('button', { name: 'Account for Workspace Owner' }).click();
  await page.getByRole('menuitem', { name: 'Agent settings' }).click();
  await page.getByRole('tab', { name: 'Custom API' }).click();
  await page.getByLabel('Base URL', { exact: true }).fill(providerUrl);
  await page.getByLabel('API key', { exact: true }).fill('browser-provider-key');
  await page.getByLabel('Model ID', { exact: true }).fill('repellet-test-model');
  await page.getByRole('button', { name: 'Save agent settings' }).click();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  const publicSettings = await (await page.request.get('/api/agent/settings')).json();
  expect(publicSettings.hasApiKey).toBe(true);
  expect(publicSettings).not.toHaveProperty('apiKey');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Codex browser workspace');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click({ timeout: 300000 });
  const id = page.url().split('/').pop()!;
  await page.getByLabel('Message Codex').fill('create agent file');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByLabel('Agent conversation')).toContainText(
    'Codex is connected to Repellet',
    { timeout: 60000 },
  );
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/projects/${id}/file?path=agent-result.txt`)).json())
          .content,
    )
    .toBe('created by agent\n');
  await expect(page.locator('.agent-activity')).toContainText('PROVIDER_KEY_HIDDEN');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Saved Codex conversation');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByLabel('Agent thread', { exact: true })).toContainText(
    'Saved Codex conversation',
  );
  const original = await page.getByLabel('Agent thread', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Fork', exact: true }).click();
  await expect(page.getByLabel('Agent thread', { exact: true })).not.toHaveValue(original);
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByLabel('Archived', { exact: true }).check();
  await expect(page.getByLabel('Agent thread', { exact: true }).locator('option')).toHaveCount(2);
  await page.getByLabel('Agent thread', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Unarchive', exact: true }).click();
  await page.getByLabel('Archived', { exact: true }).uncheck();
  await page.getByLabel('Agent thread', { exact: true }).selectOption(original);
  await page.getByLabel('Message Codex').fill('hold for steering');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByLabel('Message Codex').fill('additional guidance');
  await page.getByRole('button', { name: 'Steer', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Agent', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Agent thread', { exact: true })).toHaveValue(original);
  await expect(page.getByLabel('Agent conversation')).toContainText(
    'Codex is connected to Repellet',
  );
  await page.screenshot({ path: '.cache/agent-workspace.png', fullPage: true });
  const editorContext = await browser.newContext(),
    editor = await editorContext.newPage();
  await login(editor, 'e2e-editor');
  const users = await (await page.request.get('/api/users')).json();
  const editorId = users.find((user: any) => user.username === 'e2e-editor').id;
  await page.request.put(`/api/projects/${id}/members`, {
    headers: { origin: `http://localhost:${process.env.REPELLET_E2E_PORT || 3315}` },
    data: { userId: editorId, role: 'editor' },
  });
  await editor.goto(`/projects/${id}`);
  await expect(editor.getByRole('button', { name: 'Project settings' })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Agent', exact: true })).toHaveCount(0);
  expect((await editor.request.get(`/api/projects/${id}/agent/status`)).status()).toBe(403);
  await editorContext.close();
});
