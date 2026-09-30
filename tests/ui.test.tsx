// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Menu, Modal, UiProvider, useUi, hasOpenDialog } from '../apps/web/src/ui';
afterEach(cleanup);
function Dialogs() {
  const [outer, setOuter] = useState(false),
    [inner, setInner] = useState(false),
    [count, setCount] = useState(0);
  return (
    <>
      <button onClick={() => setOuter(true)}>Settings trigger</button>
      {outer && (
        <Modal title="Settings" onClose={() => setOuter(false)}>
          <button onClick={() => setInner(true)}>Rebuild trigger</button>
          <button onClick={() => setCount(count + 1)}>Update {count}</button>
        </Modal>
      )}
      {inner && (
        <Modal title="Rebuild" onClose={() => setInner(false)}>
          <button data-autofocus>Confirm</button>
        </Modal>
      )}
    </>
  );
}
describe('dialog ownership and focus', () => {
  it('dismisses only the top dialog, restores each trigger, and traps Tab', () => {
    render(<Dialogs />);
    const trigger = screen.getByText('Settings trigger');
    trigger.focus();
    fireEvent.click(trigger);
    expect(hasOpenDialog()).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText('Close dialog'));
    const nestedTrigger = screen.getByText('Rebuild trigger');
    nestedTrigger.focus();
    fireEvent.click(nestedTrigger);
    const confirm = screen.getByText('Confirm');
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getAllByLabelText('Close dialog')[1]);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Rebuild' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(document.activeElement).toBe(nestedTrigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
    expect(hasOpenDialog()).toBe(false);
  });
  it('does not restore background focus when onClose changes', () => {
    render(<Dialogs />);
    fireEvent.click(screen.getByText('Settings trigger'));
    const update = screen.getByText('Update 0');
    update.focus();
    fireEvent.click(update);
    expect(document.activeElement).toBe(screen.getByText('Update 1'));
  });
  it('captures the trigger before focusing the prompt and enforces password constraints', async () => {
    function Ask() {
      const ui = useUi();
      return (
        <button onClick={() => ui.ask({ title: 'Reset', password: true })}>Reset trigger</button>
      );
    }
    render(
      <UiProvider>
        <Ask />
      </UiProvider>,
    );
    const trigger = screen.getByText('Reset trigger');
    trigger.focus();
    fireEvent.click(trigger);
    const input = screen.getByLabelText('Name') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.minLength).toBe(12);
    expect(input.maxLength).toBe(128);
    await act(async () => fireEvent.keyDown(document, { key: 'Escape' }));
    expect(document.activeElement).toBe(trigger);
  });
});
describe('menu keyboard interaction', () => {
  it('places focus, wraps arrows, supports Home/End, and restores the trigger on Escape', async () => {
    const activate = vi.fn();
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Actions</button>
          {open && (
            <Menu onClose={() => setOpen(false)}>
              <button>First</button>
              <button disabled>Disabled</button>
              <button onClick={activate}>Last</button>
            </Menu>
          )}
        </>
      );
    }
    render(<Example />);
    const trigger = screen.getByText('Actions');
    trigger.focus();
    fireEvent.click(trigger);
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(document, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document, { key: 'End' });
    expect(document.activeElement).toBe(items[1]);
    await userEvent.keyboard('{Enter}');
    expect(activate).toHaveBeenCalledOnce();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
