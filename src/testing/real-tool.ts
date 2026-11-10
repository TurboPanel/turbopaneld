import { join } from "@std/path";

/**
 * Absolute path of a system tool in `/usr/bin` or `/bin`, so a test can link
 * it into a sandbox `PATH` that holds nothing else.
 */
export async function realTool(name: string): Promise<string> {
  for (const dir of ["/usr/bin", "/bin"]) {
    try {
      await Deno.stat(join(dir, name));
      return join(dir, name);
    } catch {
      // try the next directory
    }
  }
  throw new Error(`${name} not found`);
}
