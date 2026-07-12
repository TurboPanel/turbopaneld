import type { LoadGauges } from "./types.ts";

export function parseLoadavg(text: string): LoadGauges | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return null;

  const one = Number(parts[0]);
  const five = Number(parts[1]);
  const fifteen = Number(parts[2]);
  if ([one, five, fifteen].some((n) => Number.isNaN(n))) return null;

  return { one, five, fifteen };
}
