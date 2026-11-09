/**
 * CPU model name for Arm hosts, whose `/proc/cpuinfo` has no `model name`.
 *
 * Each processor block carries `CPU implementer` and `CPU part` instead; this
 * names the core the same way the util-linux CPU listing does (`Cortex-A76`
 * for implementer `0x41`, part `0xd0b`). Only parts in the table get a name:
 * an unknown pair returns `undefined` rather than a guess.
 */

/** Arm Ltd. (`0x41`) cores, by `CPU part`. */
const ARM_PARTS: Readonly<Record<string, string>> = {
  "0xd03": "Cortex-A53",
  "0xd04": "Cortex-A35",
  "0xd05": "Cortex-A55",
  "0xd07": "Cortex-A57",
  "0xd08": "Cortex-A72",
  "0xd09": "Cortex-A73",
  "0xd0a": "Cortex-A75",
  "0xd0b": "Cortex-A76",
  "0xd0c": "Neoverse-N1",
  "0xd0d": "Cortex-A77",
  "0xd40": "Neoverse-V1",
  "0xd41": "Cortex-A78",
  "0xd44": "Cortex-X1",
  "0xd46": "Cortex-A510",
  "0xd47": "Cortex-A710",
  "0xd48": "Cortex-X2",
  "0xd49": "Neoverse-N2",
  "0xd4b": "Cortex-A78C",
  "0xd4f": "Neoverse-V2",
  "0xd80": "Cortex-A520",
  "0xd81": "Cortex-A720",
  "0xd82": "Cortex-X4",
  "0xd84": "Neoverse-V3",
  "0xd8e": "Neoverse-N3",
};

/** Ampere (`0xc0`) cores, by `CPU part`. */
const AMPERE_PARTS: Readonly<Record<string, string>> = {
  "0xac3": "Ampere-1",
  "0xac4": "Ampere-1a",
};

const PARTS_BY_IMPLEMENTER: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "0x41": ARM_PARTS,
  "0xc0": AMPERE_PARTS,
};

/** Core name for one `CPU implementer` / `CPU part` pair, if known. */
export function armCpuPartName(
  implementer: string | undefined,
  part: string | undefined,
): string | undefined {
  if (!implementer || !part) return undefined;
  return PARTS_BY_IMPLEMENTER[implementer.trim().toLowerCase()]?.[
    part.trim().toLowerCase()
  ];
}

/**
 * Model name for a whole Arm `/proc/cpuinfo`: the known core names in the
 * order they first appear, joined with ` + ` on a mixed-core chip
 * (`Cortex-A76 + Cortex-A55`). `undefined` when no block names a known core.
 */
export function armCpuModelFromCpuinfo(
  cpuinfoText: string,
): string | undefined {
  const names: string[] = [];
  for (const block of cpuinfoText.split(/\n\s*\n/)) {
    let implementer: string | undefined;
    let part: string | undefined;
    for (const line of block.split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      if (key === "CPU implementer") implementer = line.slice(idx + 1);
      else if (key === "CPU part") part = line.slice(idx + 1);
    }
    const name = armCpuPartName(implementer, part);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length > 0 ? names.join(" + ") : undefined;
}
