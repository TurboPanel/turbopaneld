/**
 * Run the docker CLI for the real-server tests that start throwaway
 * containers. `dockerReachable` is false when no Docker answers, which those
 * tests use to skip themselves.
 */

export type DockerResult = {
  success: boolean;
  stdout: string;
  stderr: string;
};

export async function docker(
  args: string[],
  input?: string,
): Promise<DockerResult> {
  const child = new Deno.Command("docker", {
    args,
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const out = await child.output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return {
    success: out.success,
    stdout: decode(out.stdout),
    stderr: decode(out.stderr),
  };
}

export async function dockerReachable(): Promise<boolean> {
  try {
    return (await docker(["info"])).success;
  } catch {
    return false;
  }
}
