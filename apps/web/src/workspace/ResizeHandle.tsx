import { useEffect, useRef } from 'react';
export function ResizeHandle({
  horizontal = false,
  onStart,
  onDelta,
}: {
  horizontal?: boolean;
  onStart: () => void;
  onDelta: (delta: number) => void;
}) {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return (
    <div
      className={`resize-handle ${horizontal ? 'horizontal' : ''}`}
      role="separator"
      aria-label={horizontal ? 'Resize terminal' : 'Resize panel'}
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      tabIndex={0}
      onKeyDown={(e) => {
        const decrease = horizontal ? 'ArrowUp' : 'ArrowLeft';
        const increase = horizontal ? 'ArrowDown' : 'ArrowRight';
        if (e.key === decrease || e.key === increase) {
          e.preventDefault();
          onStart();
          onDelta(e.key === decrease ? -10 : 10);
        }
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        cleanup.current?.();
        onStart();
        let previous = horizontal ? e.clientY : e.clientX;
        const move = (event: PointerEvent) => {
          const current = horizontal ? event.clientY : event.clientX;
          onDelta(current - previous);
          previous = current;
        };
        const end = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', end);
          window.removeEventListener('pointercancel', end);
          cleanup.current = null;
          document.body.classList.remove('resizing');
        };
        cleanup.current = end;
        document.body.classList.add('resizing');
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end, { once: true });
        window.addEventListener('pointercancel', end, { once: true });
      }}
    />
  );
}
