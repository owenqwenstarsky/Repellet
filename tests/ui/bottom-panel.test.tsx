// @vitest-environment jsdom
import { useState } from 'react';
import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceBottomPanel } from '../../apps/web/src/workspace/WorkspaceBottomPanel';
import { PreparationLogsPanel } from '../../apps/web/src/workspace/PreparationLogsPanel';
import { deferred, project } from './helpers';

it('supports accessible tab navigation and keeps visited content mounted while hidden', async () => {
  function Fixture() {
    const [active, setActive] = useState('terminal');
    const [visible, setVisible] = useState(true);
    return (
      <>
        <button onClick={() => setVisible(true)}>Reveal</button>
        <WorkspaceBottomPanel
          active={active}
          visible={visible}
          height={250}
          onSelect={setActive}
          onHide={() => setVisible(false)}
          tabs={[
            { id: 'terminal', label: 'Terminal', content: <input aria-label="Terminal input" /> },
            { id: 'preparation', label: 'Preparation Logs', content: <p>Output</p> },
          ]}
        />
      </>
    );
  }
  render(<Fixture />);
  const input = screen.getByLabelText('Terminal input');
  fireEvent.change(input, { target: { value: 'pending command' } });
  const terminalTab = screen.getByRole('tab', { name: 'Terminal', exact: true });
  terminalTab.focus();
  const keyboard = userEvent.setup();
  await keyboard.keyboard('{End}');
  const logsTab = screen.getByRole('tab', { name: 'Preparation Logs' });
  expect(document.activeElement).toBe(logsTab);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('tabpanel').id).toBe(logsTab.getAttribute('aria-controls'));
  await keyboard.keyboard('{ArrowRight}');
  expect(document.activeElement).toBe(terminalTab);
  expect(screen.getByRole('textbox')).toBe(input);
  expect((input as HTMLInputElement).value).toBe('pending command');
  fireEvent.click(screen.getByLabelText('Hide bottom panel'));
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByText('Reveal'));
  expect(screen.getByRole('textbox')).toBe(input);
});

it('retains preparation errors, guards retries, and excludes viewer retry controls', async () => {
  const pending = deferred<void>();
  const retry = vi.fn().mockReturnValue(pending.promise);
  const props = {
    preparation: { ...project.preparation, status: 'failed' as const, error: 'Install failed' },
    log: 'npm output',
    visible: true,
    editable: true,
    onRetry: retry,
  };
  const view = render(<PreparationLogsPanel {...props} />);
  const button = screen.getByRole('button', { name: 'Retry preparation' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(retry).toHaveBeenCalledTimes(1);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  await act(async () => pending.reject(new Error('Retry unavailable')));
  expect(screen.getByRole('alert').textContent).toBe('Retry unavailable');
  expect(screen.getByText('Install failed')).toBeTruthy();
  view.rerender(<PreparationLogsPanel {...props} editable={false} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByLabelText('Preparation output').textContent).toBe('npm output');
});

it('follows appended output only at the bottom, including after being hidden', () => {
  const props = {
    preparation: project.preparation,
    log: 'first',
    visible: true,
    editable: true,
    onRetry: vi.fn(),
  };
  const view = render(<PreparationLogsPanel {...props} />);
  const output = screen.getByLabelText('Preparation output');
  let height = 1000;
  Object.defineProperties(output, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 100 },
  });
  view.rerender(<PreparationLogsPanel {...props} log="second" />);
  expect(output.scrollTop).toBe(1000);
  output.scrollTop = 200;
  fireEvent.scroll(output);
  height = 1200;
  view.rerender(<PreparationLogsPanel {...props} log="third" />);
  expect(output.scrollTop).toBe(200);
  view.rerender(<PreparationLogsPanel {...props} log="fourth" visible={false} />);
  view.rerender(<PreparationLogsPanel {...props} log="fourth" />);
  expect(output.scrollTop).toBe(200);
  output.scrollTop = 1100;
  fireEvent.scroll(output);
  view.rerender(<PreparationLogsPanel {...props} log="fifth" visible={false} />);
  height = 1500;
  view.rerender(<PreparationLogsPanel {...props} log="sixth" />);
  expect(output.scrollTop).toBe(1500);
});
