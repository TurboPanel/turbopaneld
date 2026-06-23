/** Anchor for `deno compile --include dist/orchestration.tar.zst` (see deno.json `compile.include`). */
export const EMBEDDED_ORCHESTRATION_BUNDLE = new URL(
  "./dist/orchestration.tar.zst",
  import.meta.url,
);
