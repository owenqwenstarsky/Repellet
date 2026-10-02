/** The Clipboard API requires HTTPS, but self-hosted dev instances also use HTTP. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Some browsers expose the API but deny permission. Try the selection fallback.
    }
  }
  const focused = document.activeElement;
  const input =
    focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
  const start = input?.selectionStart ?? null;
  const end = input?.selectionEnd ?? null;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : [];
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  // Keep the selection inside any active dialog's focus trap.
  const container = focused instanceof Element ? focused.closest('[role="dialog"]') : null;
  (container || document.body).append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    if (!document.execCommand?.('copy'))
      throw new Error('Couldn’t copy automatically. Select the code and copy it manually.');
  } catch {
    throw new Error('Couldn’t copy automatically. Select the code and copy it manually.');
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    if (input && start !== null && end !== null) input.setSelectionRange(start, end);
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
