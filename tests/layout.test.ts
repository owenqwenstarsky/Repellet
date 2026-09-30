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
it('keeps subdued active text above 4.5:1 on its surface', () => {
  const css = readFileSync('apps/web/src/styles.css', 'utf8');
  for (const [selector, background] of [
    ['textarea::placeholder', '141619'],
    ['.breadcrumbs', '17191d'],
    ['.dashboard-footer', '1b1e23'],
    ['.editor-welcome > small', '17191d'],
  ]) {
    const body = css.slice(css.indexOf(selector));
    const color = /color: #([0-9a-f]{6})/.exec(body)![1];
    expect((luminance(color) + 0.05) / (luminance(background) + 0.05)).toBeGreaterThanOrEqual(4.5);
  }
});
