/**
 * The managed-engine census — what one running instance reports to the
 * metrics `managed.storage` family (`../../metrics/collector/managed-engines.ts`):
 * whether it passes its readiness probe right now, and how much of its
 * connection budget is in use.
 *
 * Pure parsing lives here so every engine runtime's `readCensus` reduces the
 * same way and the sampler's tests never need a real engine. `null` is the
 * honest value for a reading that could not be taken — never `0`.
 */

export type ManagedEngineCensus = {
  /** The engine answered its readiness probe (`pg_isready` / `mysqladmin ping`). */
  healthy: boolean;
  /** Client connections open right now; `null` when the census query failed. */
  connectionsUsed: number | null;
  /** The configured connection ceiling (`max_connections`); `null` when unread. */
  connectionsMax: number | null;
};

/** The census of an instance that did not answer its readiness probe. */
export const DOWN_ENGINE_CENSUS: ManagedEngineCensus = {
  healthy: false,
  connectionsUsed: null,
  connectionsMax: null,
};

/** The census of an instance that is up but whose census query could not be read. */
export const UNREAD_ENGINE_CENSUS: ManagedEngineCensus = {
  healthy: true,
  connectionsUsed: null,
  connectionsMax: null,
};

/** A non-negative integer from a query cell, or `null` — never coerced. */
export function parseCensusCount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Reduce `psql -t -A -F '\t'` output of {@link connectionCensusSql} — one
 * row, `used<TAB>max` — to a healthy census.
 */
export function parsePostgresConnectionCensus(
  rows: readonly (readonly string[])[],
): ManagedEngineCensus {
  const first = rows[0];
  return {
    healthy: true,
    connectionsUsed: parseCensusCount(first?.[0]),
    connectionsMax: parseCensusCount(first?.[1]),
  };
}

/**
 * Reduce `mysql -N -B -e` output of the two-statement MySQL/MariaDB census —
 * a `Threads_connected<TAB>n` row from `SHOW GLOBAL STATUS` followed by the
 * bare `@@max_connections` value — to a healthy census. Either half missing
 * leaves that field `null`.
 */
export function parseMysqlConnectionCensus(
  stdout: string,
): ManagedEngineCensus {
  let connectionsUsed: number | null = null;
  let connectionsMax: number | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const cells = trimmed.split("\t");
    if (cells.length >= 2 && cells[0]!.toLowerCase() === "threads_connected") {
      connectionsUsed = parseCensusCount(cells[1]);
      continue;
    }
    if (cells.length === 1 && connectionsMax === null) {
      connectionsMax = parseCensusCount(cells[0]);
    }
  }
  return { healthy: true, connectionsUsed, connectionsMax };
}
