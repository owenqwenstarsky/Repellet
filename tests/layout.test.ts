import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { panelDimensions, remapPath, runEligible } from '../apps/web/src/workspaceState';
import { gitGroups, isConflicted } from '../apps/web/src/gitState';
describe('panel budgets', () => {
  for (const width of [800, 900, 1024, 1280, 1440])
    for (const height of [240, 430, 522, 800]) {
      it(`reserves editor space at ${width} × ${height}, including banner-reduced space`, () => {
        const requested = { explorer: 480, preview: 720, terminal: 550 };
        const sizes = panelDimensions(width, height, requested, true, true);
        expect(width - 55 - sizes.explorer - sizes.preview).toBeGreaterThanOrEqual(280);
        expect(height - sizes.terminal - 5).toBeGreaterThanOrEqual(160);
        expect(requested).toEqual({ explorer: 480, preview: 720, terminal: 550 });
        const hidden = panelDimensions(width, height, requested, false, false);
        expect(hidden.preview).toBe(0);
        expect(hidden.terminal).toBe(0);
      });
    }
  it('shrinks preview first and restores requested sizes when space returns', () => {
    const requested = { explorer: 232, preview: 420, terminal: 230 };
    expect(panelDimensions(900, 500, requested, true, true).explorer).toBe(232);
    expect(panelDimensions(1440, 800, requested, true, true)).toEqual(requested);
  });
});
describe('path and action rules', () => {
  it('maps descendants without changing similarly named siblings', () => {
    expect(remapPath('src/a.ts', { from: 'src', to: 'lib' })).toBe('lib/a.ts');
    expect(remapPath('src-old/a.ts', { from: 'src' })).toBe('src-old/a.ts');
    expect(remapPath('src/a.ts', { from: 'src' })).toBeNull();
  });
  it('allows Run only when all eligibility conditions are met', () => {
    const ready = { state: 'running', role: 'owner', storageExceeded: false };
    expect(runEligible(ready, false, false)).toBe(true);
    for (const p of [
      null,
      { ...ready, state: 'starting' },
      { ...ready, role: 'viewer' },
      { ...ready, storageExceeded: true },
    ])
      expect(runEligible(p, false, false)).toBe(false);
    expect(runEligible(ready, true, false)).toBe(false);
    expect(runEligible(ready, false, true)).toBe(false);
  });
  it('shows both sides of mixed changes and every conflict combination', () => {
    const mixed = { path: 'mixed.ts', index: 'M', worktree: 'M' };
    const deleted = { path: 'deleted.ts', index: ' ', worktree: 'D' };
    const groups = gitGroups([mixed, deleted]);
    expect(groups[1].entries).toContain(mixed);
    expect(groups[2].entries).toEqual([mixed, deleted]);
    for (const status of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      const conflict = { path: 'conflict', index: status[0], worktree: status[1] };
      expect(isConflicted(conflict)).toBe(true);
      expect(gitGroups([conflict])[1].entries).toHaveLength(0);
    }
  });
});
function luminance(hex: string) {
  const rgb = hex
    .match(/\w\w/g)!
    .map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
const tokens = Object.fromEntries(
  [
    ...readFileSync('apps/web/src/styles/tokens.css', 'utf8').matchAll(
      /--([\w-]+):\s*(#[0-9a-f]{6})\b/g,
    ),
  ].map((m) => [m[1]!, m[2]!.slice(1)]),
);
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
// Resolves the first color declared in a selector's rule body, following var() references.
function colorOf(css: string, selector: string) {
  const body = css.slice(css.indexOf(selector + ' {'));
  const value = /\bcolor:\s*([^;]+);/.exec(body.slice(0, body.indexOf('}')))![1]!.trim();
  const token = /var\(--([\w-]+)\)/.exec(value)?.[1];
  return token ? tokens[token]! : value.slice(1);
}
describe('color tokens', () => {
  const text = ['text-strong', 'text', 'text-secondary', 'text-muted', 'text-subtle'];
  const surfaces = ['bg', 'bg-inset', 'panel', 'surface', 'raised', 'statusbar'];
  it('keeps every text token above 4.5:1 on every surface', () => {
    for (const t of text)
      for (const s of surfaces)
        expect(
          contrast(tokens['color-' + t]!, tokens['color-' + s]!),
          `${t} on ${s}`,
        ).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps subdued text rules above 4.5:1 on their surface', () => {
    const css = ['base', 'workspace']
      .map((n) => readFileSync(`apps/web/src/styles/${n}.css`, 'utf8'))
      .join('\n');
    for (const [selector, surface] of [
      ['textarea::placeholder', 'bg'],
      ['.breadcrumbs', 'panel'],
      ['.editor-welcome > small', 'panel'],
      ['.workspace-status', 'statusbar'],
    ])
      expect(
        contrast(colorOf(css, selector!), tokens['color-' + surface]!),
        selector,
      ).toBeGreaterThanOrEqual(4.5);
  });
  it('matches the palette shared with Monaco and xterm', async () => {
    const { palette } = await import('../apps/web/src/theme');
    for (const [key, value] of Object.entries(palette)) {
      const name = 'color-' + key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
      expect('#' + tokens[name], name).toBe(value);
    }
  });
});
