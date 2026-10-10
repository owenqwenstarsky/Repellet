// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MenuButton, MenuItem } from '../../apps/web/src/ui';

it('keeps the account menu at its natural height when positioned above the trigger', async () => {
  const stylesheet = document.createElement('style');
  stylesheet.textContent = ['tokens', 'components', 'shell']
    .map((name) => readFileSync(`apps/web/src/styles/${name}.css`, 'utf8'))
    .join('\n');
  document.head.append(stylesheet);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this.getAttribute('role') === 'menu'
      ? new DOMRect(0, 0, 180, 112)
      : new DOMRect(8, window.innerHeight - 68, 196, 52);
  });
  try {
    render(
      <MenuButton label="Account" menuClassName="account-menu" trigger="Owen Qwen">
        <MenuItem onSelect={() => {}}>Agent settings</MenuItem>
        <MenuItem onSelect={() => {}}>Change password</MenuItem>
        <MenuItem onSelect={() => {}}>Sign out</MenuItem>
      </MenuButton>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Account' }));
    const menu = screen.getByRole('menu');
    const style = getComputedStyle(menu);
    expect(style.position).toBe('fixed');
    expect(Number.parseFloat(style.top) + 112).toBe(window.innerHeight - 72);
    // A second vertical offset would constrain the menu's height and spill its items out.
    expect(style.bottom).toBe('auto');
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  } finally {
    stylesheet.remove();
  }
});
