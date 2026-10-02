// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { copyText } from '../apps/web/src/clipboard';

it('uses the modern clipboard API when available', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await copyText('TEST-CODE');
  expect(writeText).toHaveBeenCalledWith('TEST-CODE');
  expect(document.querySelector('textarea')).toBeNull();
});

it.each(['unavailable', 'denied'])(
  'copies with a selection when the Clipboard API is %s',
  async (mode) => {
    vi.stubGlobal('navigator', {
      clipboard:
        mode === 'denied'
          ? { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) }
          : undefined,
    });
    const input = document.createElement('input');
    input.value = 'Keep this selection';
    document.body.append(input);
    input.focus();
    input.setSelectionRange(2, 8);
    const original = Object.getOwnPropertyDescriptor(document, 'execCommand');
    const copy = vi.fn(() => {
      const selected = document.activeElement as HTMLTextAreaElement;
      expect(selected.tagName).toBe('TEXTAREA');
      expect(selected.value.slice(selected.selectionStart, selected.selectionEnd)).toBe(
        'TEST-CODE',
      );
      return true;
    });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: copy });
    try {
      await copyText('TEST-CODE');
      expect(copy).toHaveBeenCalledWith('copy');
      expect(document.querySelector('textarea')).toBeNull();
      expect(document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]);
    } finally {
      input.remove();
      if (original) Object.defineProperty(document, 'execCommand', original);
      else Reflect.deleteProperty(document, 'execCommand');
    }
  },
);

it.each(['unavailable', 'false', 'throws'])(
  'gives manual-copy instructions when selection copying is %s',
  async (mode) => {
    vi.stubGlobal('navigator', { clipboard: undefined });
    const original = Object.getOwnPropertyDescriptor(document, 'execCommand');
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value:
        mode === 'unavailable'
          ? undefined
          : () => {
              if (mode === 'throws') throw new Error('Copy denied');
              return false;
            },
    });
    try {
      await expect(copyText('TEST-CODE')).rejects.toThrow('Select the code and copy it manually');
      expect(document.querySelector('textarea')).toBeNull();
    } finally {
      if (original) Object.defineProperty(document, 'execCommand', original);
      else Reflect.deleteProperty(document, 'execCommand');
    }
  },
);
