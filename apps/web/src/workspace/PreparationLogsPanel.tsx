import { useLayoutEffect, useRef, useState } from 'react';
import type { Preparation } from '@repellet/shared';
import { Button } from '../ui';
import { errorMessage } from '../api';

export const preparationLabels: Record<Preparation['status'], string> = {
  none: 'No preparation required',
  required: 'Dependencies need installation',
  pending: 'Preparing files',
  files: 'Preparing files',
  installing: 'Installing dependencies',
  ready: 'Ready to run',
  failed: 'Preparation failed',
  interrupted: 'Preparation interrupted',
};

export function PreparationLogsPanel({
  preparation,
  log,
  visible,
  editable,
  onRetry,
}: {
  preparation: Preparation;
  log: string;
  visible: boolean;
  editable: boolean;
  onRetry: () => Promise<unknown>;
}) {
  const scroll = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const pending = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const failed = ['failed', 'interrupted'].includes(preparation.status);
  useLayoutEffect(() => {
    if (visible && follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [log, visible]);
  async function retry() {
    if (pending.current) return;
    pending.current = true;
    setRetrying(true);
    setRetryError('');
    try {
      await onRetry();
    } catch (error) {
      setRetryError(errorMessage(error));
    } finally {
      pending.current = false;
      setRetrying(false);
    }
  }
  return (
    <div className="preparation-panel">
      <div className="preparation-toolbar">
        <span role="status" className={`preparation-status ${failed ? 'failed' : ''}`}>
          {preparationLabels[preparation.status]}
        </span>
        {editable && (failed || preparation.status === 'required') && (
          <Button size="sm" disabled={retrying} onClick={retry}>
            {retrying
              ? 'Starting…'
              : preparation.status === 'required'
                ? 'Install dependencies'
                : 'Retry preparation'}
          </Button>
        )}
      </div>
      {preparation.error && <p className="preparation-error">{preparation.error}</p>}
      {retryError && (
        <p role="alert" className="preparation-error">
          {retryError}
        </p>
      )}
      <pre
        className="preparation-log"
        ref={scroll}
        tabIndex={0}
        aria-label="Preparation output"
        onScroll={() => {
          const element = scroll.current;
          if (visible && element)
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
        }}
      >
        {log || 'No preparation output yet.'}
      </pre>
    </div>
  );
}
