export function parseUptime(text: string): number | null {
  const first = text.trim().split(/\s+/)[0];
  if (!first) return null;
  const seconds = Number(first);
  if (!Number.isFinite(seconds)) return null;
  return Math.floor(seconds);
}
