/**
 * `nvidia-smi --query-gpu` adapter — the last-resort NVIDIA source when
 * neither dcgm-exporter nor NVML answered (NVML installed outside the
 * `--allow-ffi` grant, a container-toolkit layout, an FFI regression). It
 * spawns one subprocess per tick, so `buildGpuSamples` only consults it when
 * no earlier adapter in the chain returned a reading (`fallbackOnly`).
 *
 * The query sticks to fields every driver since R390 knows: one unknown field
 * fails the whole query. Values arrive with `nounits`, but placeholders
 * (`[N/A]`, `N/A`, `[Not Supported]`, `[Unknown Error]`,
 * `[Insufficient Permissions]`) and stray unit suffixes (` %`, ` MiB`, ` W`)
 * are tolerated so a driver that changes its formatting degrades to `null`
 * for that one field instead of the whole GPU.
 */
import type { GpuTopology } from "../../../contracts/topology-types.ts";
import type { GpuAdapter, GpuReadContext, GpuReading } from "./adapter.ts";

const QUERY_FIELDS = [
  "pci.bus_id",
  "utilization.gpu",
  "utilization.memory",
  "memory.used",
  "temperature.gpu",
  "power.draw",
  "memory.total",
] as const;

const MIB = 1024 * 1024;

/** One parsed `nvidia-smi` row, keyed by normalized PCI slot. */
export type NvidiaSmiRow = {
  utilizationPercent: number | null;
  memoryActivityPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  temperatureCelsius: number | null;
  powerWatts: number | null;
};

/** `00000000:0A:00.0` → `0000:0a:00.0` (sysfs `PCI_SLOT_NAME` form). */
export function normalizeNvidiaBusId(busId: string): string {
  const trimmed = busId.trim().toLowerCase();
  const colon = trimmed.indexOf(":");
  if (colon <= 4) return trimmed;
  return `${trimmed.slice(colon - 4, colon)}${trimmed.slice(colon)}`;
}

/** Leading decimal number of a CSV cell; `null` for placeholders. */
export function parseNvidiaSmiNumber(cell: string | undefined): number | null {
  const text = cell?.trim() ?? "";
  if (!text || text.startsWith("[") || /^n\/a$/i.test(text)) return null;
  const match = /^-?\d+(?:\.\d+)?/.exec(text);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function clampPercent(value: number | null): number | null {
  return value === null ? null : Math.min(100, value);
}

/** Parse `--format=csv,noheader,nounits` output for {@link QUERY_FIELDS}. */
export function parseNvidiaSmiQuery(text: string): Map<string, NvidiaSmiRow> {
  const rows = new Map<string, NvidiaSmiRow>();
  for (const line of text.split("\n")) {
    const cells = line.split(",");
    // `memory.total` is the last column and optional: a row without it still parses.
    if (cells.length < QUERY_FIELDS.length - 1) continue;
    const slot = normalizeNvidiaBusId(cells[0]);
    if (!slot) continue;
    const memoryMiB = parseNvidiaSmiNumber(cells[3]);
    const memoryTotalMiB = parseNvidiaSmiNumber(cells[6]);
    rows.set(slot, {
      utilizationPercent: clampPercent(parseNvidiaSmiNumber(cells[1])),
      memoryActivityPercent: clampPercent(parseNvidiaSmiNumber(cells[2])),
      memoryUsedBytes: memoryMiB === null ? null : Math.round(memoryMiB * MIB),
      memoryTotalBytes: memoryTotalMiB === null
        ? null
        : Math.round(memoryTotalMiB * MIB),
      temperatureCelsius: parseNvidiaSmiNumber(cells[4]),
      powerWatts: parseNvidiaSmiNumber(cells[5]),
    });
  }
  return rows;
}

/**
 * Runs the query: stdout text, `undefined` when this run failed (driver
 * busy, non-zero exit), `null` when nvidia-smi cannot be spawned at all.
 */
export type NvidiaSmiRunner = () => Promise<string | null | undefined>;

/** nvidia-smi can hang for minutes when a GPU falls off the bus; kill it instead. */
export const NVIDIA_SMI_TIMEOUT_MS = 8_000;

async function runNvidiaSmi(): Promise<string | null | undefined> {
  const signal = AbortSignal.timeout(NVIDIA_SMI_TIMEOUT_MS);
  try {
    const { code, stdout } = await new Deno.Command("nvidia-smi", {
      args: [
        `--query-gpu=${QUERY_FIELDS.join(",")}`,
        "--format=csv,noheader,nounits",
      ],
      stdout: "piped",
      stderr: "null",
      signal,
    }).output();
    if (code !== 0) return undefined;
    return new TextDecoder().decode(stdout);
  } catch {
    // Killed at the deadline: this run failed, the binary is still there.
    if (signal.aborted) return undefined;
    // Not installed / not on the allow-run list on this host.
    return null;
  }
}

export class NvidiaSmiGpuAdapter implements GpuAdapter {
  readonly id = "nvidia-smi" as const;
  readonly fallbackOnly = true;
  readonly #run: NvidiaSmiRunner;
  #unavailable = false;
  /** One spawn per tick serves every GPU read in that tick. */
  #pending: { at: number; rows: Promise<Map<string, NvidiaSmiRow>> } | null =
    null;
  readonly #now: () => number;

  constructor(deps?: { run?: NvidiaSmiRunner; now?: () => number }) {
    this.#run = deps?.run ?? runNvidiaSmi;
    this.#now = deps?.now ?? Date.now;
  }

  probe(): Promise<void> {
    return Promise.resolve();
  }

  #rows(): Promise<Map<string, NvidiaSmiRow>> {
    const now = this.#now();
    if (this.#pending && now - this.#pending.at < 1000) {
      return this.#pending.rows;
    }
    const rows = this.#run().then((text) => {
      // A host without nvidia-smi never spawns again for this process.
      if (text === null) this.#unavailable = true;
      return parseNvidiaSmiQuery(text ?? "");
    });
    this.#pending = { at: now, rows };
    return rows;
  }

  async read(
    gpu: GpuTopology,
    _ctx: GpuReadContext,
  ): Promise<GpuReading | null> {
    if (this.#unavailable || !gpu.pciPath) return null;
    const row = (await this.#rows()).get(normalizeNvidiaBusId(gpu.pciPath));
    if (!row) return null;
    return {
      utilizationPercent: row.utilizationPercent,
      memoryUsedBytes: row.memoryUsedBytes,
      memoryTotalBytes: row.memoryTotalBytes,
      memoryActivityPercent: row.memoryActivityPercent,
      temperatureCelsius: row.temperatureCelsius,
      memoryTemperatureCelsius: null,
      powerWatts: row.powerWatts,
      pcieReceiveBytesPerSecond: null,
      pcieTransmitBytesPerSecond: null,
      throttlePercent: null,
    };
  }
}
