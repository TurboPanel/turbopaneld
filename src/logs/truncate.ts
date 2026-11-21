/**
 * Byte-bounded tail truncation shared by the on-demand log collectors
 * (container tails and managed service tails).
 */

/** Stay under the cell `MAX_DAEMON_WS_LOGS_CHARS` / UTF-8 frame wire cap. */
export const MAX_LOG_BYTES = 200 * 1024;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Keep the tail of `text` within `maxBytes` UTF-8 bytes. */
export function truncateLogTail(
  text: string,
  maxBytes: number = MAX_LOG_BYTES,
): string {
  const encoded = utf8Encoder.encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  const slice = encoded.subarray(encoded.byteLength - maxBytes);
  let start = 0;
  // Skip a leading continuation so the cut stays on a code-point boundary.
  while (
    start < slice.length && (slice[start]! & 0b1100_0000) === 0b1000_0000
  ) {
    start += 1;
  }
  return utf8Decoder.decode(slice.subarray(start));
}
