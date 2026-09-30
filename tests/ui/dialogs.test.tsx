// @vitest-environment jsdom
import { useState, StrictMode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../../apps/web/src/ui';

function Harness({ tick = 0 }: { tick?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <Modal title="Parent" onClose={() => setOpen(false)}>
          <input autoFocus aria-label="Name" />
          <select aria-label="Repository">
            <option>One</option>
          </select>
          <span>{tick}</span>
        </Modal>
      )}
    </>
  );
}
describe('dialog focus', () => {
  it('keeps focus through parent polling and restores the opener on close', async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    const opener = screen.getByText('Open');
    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    await user.click(screen.getByLabelText('Repository'));
    view.rerender(<Harness tick={1} />);
    expect(document.activeElement).toBe(screen.getByLabelText('Repository'));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it('only dismisses the top dialog with Escape or a lower backdrop', () => {
    const lower = vi.fn(),
      upper = vi.fn();
    const view = render(
      <>
        <Modal title="Lower" onClose={lower}>
          <button>Lower action</button>
        </Modal>
        <Modal title="Upper" onClose={upper}>
          <input autoFocus />
        </Modal>
      </>,
    );
    fireEvent.mouseDown(view.container.querySelector('.modal-backdrop')!);
    expect(lower).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
  });
  it('traps focus while excluding hidden, disabled and negative-tabindex controls', () => {
    render(
      <Modal title="Trap" onClose={() => {}}>
        <button>Last visible</button>
        <button hidden>Hidden</button>
        <div style={{ display: 'none' }}>
          <button>Hidden ancestor</button>
        </div>
        <button disabled>Disabled</button>
        <button tabIndex={-1}>Skipped</button>
      </Modal>,
    );
    screen.getByText('Last visible').focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Close dialog'));
  });
  it('restores focus from a nested dialog to its opening control', async () => {
    function Nested() {
      const [open, setOpen] = useState(false);
      return (
        <Modal title="Outer" onClose={() => {}}>
          <button onClick={() => setOpen(true)}>Inner</button>
          {open && (
            <Modal title="Inner" onClose={() => setOpen(false)}>
              <input autoFocus />
            </Modal>
          )}
        </Modal>
      );
    }
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(screen.getByText('Inner'));
    await user.keyboard('{Escape}');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByText('Inner'));
  });
});

it('preserves initial autofocus under the app Strict Mode lifecycle', async () => {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  await user.click(screen.getByText('Open'));
  expect(document.activeElement).toBe(screen.getByLabelText('Name'));
});
