import { dirname } from "@std/path";

/**
 * Write a metrics state file atomically: create the directory, write a temp
 * file with a name unique to this call, then rename it over the target.
 *
 * The temp name must be unique per call. Several collectors persist the same
 * file in one tick, and with a shared `<path>.tmp` the first rename moves the
 * file out from under the second writer, whose rename then fails with
 * "No such file".
 */
export async function writeTextFileAtomic(
  path: string,
  text: string,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(tmpPath, text);
    await Deno.rename(tmpPath, path);
  } catch (err) {
    await Deno.remove(tmpPath).catch(() => undefined);
    throw err;
  }
}
