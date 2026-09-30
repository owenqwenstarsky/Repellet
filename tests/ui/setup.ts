import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

if (typeof document !== 'undefined') {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}
