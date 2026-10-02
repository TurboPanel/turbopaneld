import { assert, assertEquals } from "@std/assert";
import {
  BufferedReader,
  type ByteSink,
  carriesFormBody,
  type Framing,
  parseRequestHead,
  relayBody,
  requestFraming,
  type RequestHead,
} from "../../orchestration/roles/docker-gate/files/http.ts";
import { parseTarget } from "../../orchestration/roles/docker-gate/files/proxy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * Differential test of the gate's request parser against Go's net/http, the
 * parser the Docker engine runs (src/testing/docker-gate-diff/main.go). The rule
 * is one-sided: the gate may refuse what Go accepts (it fails closed), but a
 * request the gate lets through must be read by Go as the gate read it: same
 * method and path, same body length and framing, nothing left over for Go to
 * take as another request, and no form field the gate did not see.
 *
 * `testdata/go-parser.json` is the harness's recorded output for
 * `testdata/parser-cases.json`. The recorded-table test always runs; the live
 * test re-runs the harness (local `go`, or `docker run golang`) and checks the
 * record is current. Set DOCKER_GATE_GO_DIFF=1 to run it (it fails when
 * neither toolchain exists).
 */
type GoResult = {
  name: string;
  ok: boolean;
  error?: string;
  method?: string;
  path?: string;
  bodyLen: number;
  chunked: boolean;
  leftover: number;
  form: Record<string, string[]>;
  formErr: boolean;
};
type GoOutput = { go: string; results: GoResult[] };
type Case = { name: string; raw: string };

const dataUrl = (name: string) =>
  new URL(`./testdata/${name}`, import.meta.url);
const cases: Case[] = JSON.parse(
  await Deno.readTextFile(dataUrl("parser-cases.json")),
);
const recorded: GoOutput = JSON.parse(
  await Deno.readTextFile(dataUrl("go-parser.json")),
);

/** Code points 0-255 are the bytes (what the harness does on the Go side). */
function bytesOf(raw: string): Uint8Array {
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

type GateView = {
  head: RequestHead;
  framing: Framing;
  bodyLen: number;
  leftover: number;
};

function endOfHead(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (
      bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 &&
      bytes[i + 3] === 10
    ) return i + 4;
  }
  return -1;
}

/** What the gate makes of the raw bytes; `undefined` when it refuses them. */
async function gateView(raw: string): Promise<GateView | undefined> {
  const bytes = bytesOf(raw);
  const end = endOfHead(bytes);
  if (end < 0) return undefined;
  try {
    const head = parseRequestHead(bytes.slice(0, end));
    const framing = requestFraming(head);
    let rest = bytes.slice(end);
    const reader = new BufferedReader({
      read(p) {
        if (rest.length === 0) return Promise.resolve(null);
        const take = Math.min(p.length, rest.length);
        p.set(rest.subarray(0, take));
        rest = rest.subarray(take);
        return Promise.resolve(take);
      },
    });
    let relayed = 0;
    const sink: ByteSink = {
      write(p) {
        relayed += p.length;
        return Promise.resolve(p.length);
      },
    };
    await relayBody(reader, framing, sink);
    const leftover = reader.buffered + rest.length;
    return { head, framing, bodyLen: relayed, leftover };
  } catch {
    return undefined; // a refusal or a short body: the gate fails closed
  }
}

function checkAgreement(gate: GateView, go: GoResult): string[] {
  // Go answers 400 and closes before anything runs: nothing to disagree about.
  if (!go.ok) return [];
  const problems: string[] = [];
  const target = parseTarget(gate.head.target);
  if (gate.head.method !== go.method) problems.push("method");
  if (!gate.head.target.includes("#") && target.path !== go.path) {
    problems.push("path");
  }
  if ((gate.framing.kind === "chunked") !== go.chunked) {
    problems.push("chunked");
  }
  if (gate.framing.kind === "length" && gate.bodyLen !== go.bodyLen) {
    problems.push("body length");
  }
  if (gate.leftover !== go.leftover) problems.push("leftover bytes");
  const formBody = carriesFormBody(gate.head, gate.framing);
  // The gate drops a `#fragment` Go keeps in the query: it over-reads (harmless).
  const fields = gate.head.target.includes("#") ? [] : Object.entries(go.form);
  for (const [key, values] of fields) {
    const seen = target.query.getAll(key);
    const same = seen.length === values.length &&
      seen.every((value, i) => value === values[i]);
    if (!same && !formBody) problems.push(`form field ${key} unseen`);
  }
  return problems;
}

test("the recorded Go table covers every case", () => {
  assertEquals(
    recorded.results.map((r) => r.name),
    cases.map((c) => c.name),
  );
});

for (const [index, entry] of cases.entries()) {
  test(`differential: ${entry.name}`, async () => {
    const go = recorded.results[index];
    assertEquals(go.name, entry.name);
    const gate = await gateView(entry.raw);
    if (gate === undefined) return; // refused: fails closed
    assertEquals(checkAgreement(gate, go), [], entry.name);
  });
}

test("the cases that were real gaps are refused or flagged", async () => {
  const byName = (name: string) => {
    const found = cases.find((c) => c.name === name);
    assert(found, name);
    return found.raw;
  };
  // Go ignores Transfer-Encoding on HTTP/1.0 and reads the chunks as a request.
  assertEquals(
    await gateView(byName("HTTP/1.0 chunked ignored by Go")),
    undefined,
  );
  // Go merges a form-encoded body into the form, ahead of the query.
  for (
    const name of [
      "form body build",
      "form body charset",
      "form body upper case type",
      "form body chunked",
      "form body on PUT",
      "form body and query",
      "two content types",
    ]
  ) {
    const gate = await gateView(byName(name));
    assert(gate, name);
    assert(carriesFormBody(gate.head, gate.framing), name);
  }
  const tar = await gateView(byName("form body tar type"));
  assert(tar && !carriesFormBody(tar.head, tar.framing));
});

async function runHarness(): Promise<GoOutput | undefined> {
  const dir = new URL("../testing/docker-gate-diff/", import.meta.url)
    .pathname;
  const file = dataUrl("parser-cases.json").pathname;
  const attempts: Array<[string, string[]]> = [
    ["go", ["run", ".", file]],
    ["docker", [
      "run",
      "--rm",
      "-v",
      `${dir}:/h:ro`,
      "-v",
      `${file}:/cases.json:ro`,
      "-w",
      "/h",
      "golang:1.23",
      "go",
      "run",
      ".",
      "/cases.json",
    ]],
  ];
  for (const [command, args] of attempts) {
    try {
      const { success, stdout } = await new Deno.Command(command, {
        args,
        cwd: dir,
        stdout: "piped",
        stderr: "null",
      }).output();
      if (success) return JSON.parse(new TextDecoder().decode(stdout));
    } catch {
      // not installed: try the next one
    }
  }
  return undefined;
}

test({
  name: "live: Go's parser still reads the cases as recorded",
  ignore: Deno.env.get("DOCKER_GATE_GO_DIFF") !== "1",
  fn: async () => {
    const live = await runHarness();
    assert(live, "neither go nor docker could run the harness");
    assertEquals(live.results, recorded.results);
  },
});
