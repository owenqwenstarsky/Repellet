import { stripVTControlCharacters } from 'node:util';

export const MAX_OUTPUT_BYTES = 64 * 1024;

/** Keep the newest complete UTF-8 characters, never a replacement character from slicing bytes. */
export function tailUtf8(text: string, maxBytes: number) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let offset = bytes.length - maxBytes;
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++;
  return bytes.subarray(offset).toString('utf8');
}

export function terminalOutput(
  session: { id: string; name: string; alive: boolean; buffer: string } | undefined,
  tailLines = 200,
) {
  if (!Number.isInteger(tailLines) || tailLines < 1 || tailLines > 1000)
    throw Object.assign(new Error('tailLines must be an integer from 1 to 1000'), {
      statusCode: 400,
    });
  // No awaits: liveness and the replay buffer belong to the same snapshot.
  if (!session?.alive) return { running: false as const };
  const text = stripVTControlCharacters(session.buffer)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  const lines = text.split('\n');
  // A trailing newline terminates the last line rather than adding another output line.
  if (lines.at(-1) === '') lines.pop();
  const tail = lines.slice(-tailLines).join('\n');
  return {
    running: true as const,
    processId: session.id,
    name: session.name,
    text: tailUtf8(tail, MAX_OUTPUT_BYTES),
    truncated: lines.length > tailLines || Buffer.byteLength(tail) > MAX_OUTPUT_BYTES,
  };
}
