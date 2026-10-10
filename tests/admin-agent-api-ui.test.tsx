// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdminAgentApi } from '../apps/web/src/AdminAgentApi';
import { UiProvider } from '../apps/web/src/ui';
import { api, post, put } from '../apps/web/src/api';
vi.mock('../apps/web/src/api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  errorMessage: (error: Error) => error.message,
}));
const config = {
  enabled: true,
  baseUrl: 'https://proxy.invalid/v1',
  hasApiKey: true,
  models: ['allowed', 'other'],
  allowedModels: ['allowed', 'missing'],
  fetchedAt: 10,
};
beforeEach(() => {
  vi.mocked(api).mockReset().mockResolvedValue(config);
  vi.mocked(post)
    .mockReset()
    .mockResolvedValue({ models: ['allowed', 'other', 'new'], fetchedAt: 20 });
  vi.mocked(put)
    .mockReset()
    .mockImplementation(async (_path, body: any) => ({ ...config, ...body }));
});
const mount = () =>
  render(
    <UiProvider>
      <AdminAgentApi />
    </UiProvider>,
  );
it('keeps keys blank, preserves missing allowed models, and leaves discovered models unchecked until selected', async () => {
  mount();
  await screen.findByLabelText('allowed');
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('missing') as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('Unavailable')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
  const added = await screen.findByLabelText('new');
  expect((added as HTMLInputElement).checked).toBe(false);
  expect(put).not.toHaveBeenCalled();
  fireEvent.click(added);
  fireEvent.click(screen.getByLabelText('allowed'));
  fireEvent.click(screen.getByRole('button', { name: 'Save agent API settings' }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith('/admin/agent-api', {
      enabled: true,
      baseUrl: config.baseUrl,
      allowedModels: ['missing', 'new'],
    }),
  );
});
it('requires loading a changed enabled connection before save and searches exact IDs', async () => {
  mount();
  await screen.findByLabelText('Responses API base URL');
  fireEvent.change(screen.getByLabelText('Responses API base URL'), {
    target: { value: 'https://new.invalid/v1' },
  });
  expect(
    (screen.getByRole('button', { name: 'Save agent API settings' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
  await screen.findByLabelText('new');
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Save agent API settings' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByLabelText('Search model IDs'), { target: { value: 'other' } });
  expect(screen.getByLabelText('other')).toBeTruthy();
  expect(screen.queryByLabelText('allowed')).toBeNull();
});
it('only permits key removal when disabled and explicitly submits null', async () => {
  mount();
  await screen.findByLabelText('Remove saved key');
  expect((screen.getByLabelText('Remove saved key') as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Enable global CLIProxyAPI'));
  fireEvent.click(screen.getByLabelText('Remove saved key'));
  fireEvent.click(screen.getByRole('button', { name: 'Save agent API settings' }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith('/admin/agent-api', {
      enabled: false,
      baseUrl: config.baseUrl,
      allowedModels: config.allowedModels,
      apiKey: null,
    }),
  );
});
