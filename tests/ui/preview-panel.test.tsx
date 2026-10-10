// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreviewPanel } from '../../apps/web/src/workspace/PreviewPanel';
import { project } from './helpers';

it.each([403, 500])(
  'keeps HTTP %s previewable and removes the warning after a successful probe',
  (httpStatus) => {
    const props = {
      project: { ...project, appStatus: { status: 'available' as const, httpStatus } },
      url: 'https://preview.example.test:42001',
      width: 600,
      revision: 0,
      editable: true,
      onRefresh: vi.fn(),
      onClose: vi.fn(),
      onRetryReadiness: vi.fn(),
    };
    const view = render(<PreviewPanel {...props} />);
    expect(screen.getByText(`The app responded with HTTP ${httpStatus}.`)).toBeTruthy();
    expect(screen.getByTitle('Project preview').getAttribute('src')).toBe(props.url);
    view.rerender(
      <PreviewPanel
        {...props}
        project={{ ...props.project, appStatus: { status: 'available', httpStatus: 200 } }}
      />,
    );
    expect(screen.queryByText(/The app responded with HTTP/)).toBeNull();
    expect(screen.getByTitle('Project preview').getAttribute('src')).toBe(props.url);
  },
);
