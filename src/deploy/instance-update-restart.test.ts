/**
 * The instance-launch role must restart a running panel whose binary the
 * installer replaced. `run.sh --instance` swaps `bin/turbopanel` and the play
 * only ensures the unit is "started", so without the check an updated host
 * kept serving the old build. The check's shell snippet is run for real here
 * against a process whose executable was deleted, one started before the file
 * on disk was touched, and one that is current.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const test = Deno.test.bind(Deno);

const MAIN_YML = fromFileUrl(
  new URL(
    "../../orchestration/roles/instance-launch/tasks/main.yml",
    import.meta.url,
  ),
);

async function role(): Promise<string> {
  return await Deno.readTextFile(MAIN_YML);
}

test("instance-launch restarts the instance when its binary was replaced, before the start-state task", async () => {
  const text = await role();
  const check = text.indexOf("- name: Read the running instance process");
  const notify = text.indexOf(
    "- name: Restart the instance when its binary was replaced under it",
  );
  const ensure = text.indexOf("- name: Ensure instance service desired state");
  assert(check !== -1 && notify > check && ensure > notify);
  const block = text.slice(notify, ensure);
  assertStringIncludes(block, "- Restart turbopanel instance");
});

function snippet(text: string, pid: number, binary: string): string {
  const start = text.indexOf(
    "cmd: |",
    text.indexOf("Read the running instance process"),
  );
  const end = text.indexOf("executable: /bin/sh", start);
  const body = text.slice(start + "cmd: |".length, end).split("\n")
    .map((line) => line.replace(/^ {6}/, "")).join("\n");
  return body
    .replace(
      /pid="\$\(systemctl show[^\n]*\n/,
      `pid=${pid}\n`,
    )
    .replaceAll("{{ turbopanel_instance_binary }}", binary);
}

async function run(script: string): Promise<string> {
  const out = await new Deno.Command("/bin/sh", {
    args: ["-c", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout).trim();
}

test({
  name: "the replaced-binary check reports stale only for an outdated process",
  ignore: Deno.build.os !== "linux",
  fn: async () => {
    const text = await role();
    const dir = await Deno.makeTempDir();
    const bin = join(dir, "app");
    await Deno.copyFile("/bin/sleep", bin);
    await Deno.chmod(bin, 0o755);
    const child = new Deno.Command(bin, { args: ["30"] }).spawn();
    try {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      // Current: binary older than the process.
      assertEquals(await run(snippet(text, child.pid, bin)), "");
      // Touched after the process started.
      await Deno.utime(bin, new Date(), new Date());
      assertEquals(await run(snippet(text, child.pid, bin)), "stale");
      // Replaced: the running executable is gone.
      await Deno.remove(bin);
      assertEquals(await run(snippet(text, child.pid, bin)), "stale");
      // Not running at all.
      assertEquals(await run(snippet(text, 2147483, bin)), "");
    } finally {
      child.kill();
      await child.status;
      await Deno.remove(dir, { recursive: true });
    }
  },
});
