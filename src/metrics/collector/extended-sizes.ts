/**
 * The contract's `extended.sizes`, `filesystemSizes` and `gpuSizes` (v7): the
 * capacity every percentage is taken against, read in the same tick as the
 * reading itself. This is what lets a resize or a balloon change a total
 * without starting a new topology generation. Pure and synchronous. A total
 * that is unknown or not positive is left out, never sent as `0`.
 */
import type {
  ExtendedFilesystemSize,
  ExtendedGpuSize,
  ExtendedSizes,
  MetricsExtended,
} from "../../contracts/metrics-contract.ts";
import type { FilesystemSizeReading } from "./filesystem.ts";

export type SizesInput = {
  memoryTotalBytes: number | null | undefined;
  swapTotalBytes: number | null | undefined;
  commitLimitBytes: number | null | undefined;
  logicalCores: number | null | undefined;
  root:
    | {
      totalBytes: number | null;
      totalInodes: number | null;
    }
    | null
    | undefined;
  filesystems: readonly FilesystemSizeReading[];
  gpus: readonly { gpuId: string; memoryTotalBytes: number | null }[];
};

function positive(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** Most per-entity totals one sample carries (the contract's per-array cap). */
const MAX_ENTITY_SIZES = 64;

export function buildExtendedSizes(
  input: SizesInput,
): Pick<MetricsExtended, "sizes" | "filesystemSizes" | "gpuSizes"> | undefined {
  const sizes: ExtendedSizes = {};
  const set = (key: keyof ExtendedSizes, value: number | null | undefined) => {
    const known = positive(value);
    if (known !== undefined) sizes[key] = known;
  };
  set("memoryTotalBytes", input.memoryTotalBytes);
  set("swapTotalBytes", input.swapTotalBytes);
  set("commitLimitBytes", input.commitLimitBytes);
  set("logicalCores", input.logicalCores);
  set("rootFilesystemTotalBytes", input.root?.totalBytes);
  set("rootFilesystemTotalInodes", input.root?.totalInodes);

  const filesystemSizes: ExtendedFilesystemSize[] = [];
  for (const fs of input.filesystems) {
    const totalBytes = positive(fs.totalBytes);
    const totalInodes = positive(fs.totalInodes);
    if (totalBytes === undefined && totalInodes === undefined) continue;
    filesystemSizes.push({
      filesystemId: fs.filesystemId,
      ...(totalBytes !== undefined ? { totalBytes } : {}),
      ...(totalInodes !== undefined ? { totalInodes } : {}),
    });
  }
  const gpuSizes: ExtendedGpuSize[] = [];
  for (const gpu of input.gpus) {
    const memoryTotalBytes = positive(gpu.memoryTotalBytes);
    if (memoryTotalBytes !== undefined) {
      gpuSizes.push({ gpuId: gpu.gpuId, memoryTotalBytes });
    }
  }

  const out: Pick<MetricsExtended, "sizes" | "filesystemSizes" | "gpuSizes"> =
    {};
  if (Object.keys(sizes).length > 0) out.sizes = sizes;
  if (filesystemSizes.length > 0) {
    out.filesystemSizes = filesystemSizes.slice(0, MAX_ENTITY_SIZES);
  }
  if (gpuSizes.length > 0) out.gpuSizes = gpuSizes.slice(0, MAX_ENTITY_SIZES);
  return Object.keys(out).length > 0 ? out : undefined;
}
