import { assertEquals, assertThrows } from "@std/assert";
import { createTempLayout } from "../testing/temp-layout.ts";
import {
  PANEL_IDENTITY_PIN_FILE,
  panelPinReport,
  parsePanelIdentityPin,
  readPanelIdentityPin,
} from "./panel-identity-pin.ts";

/** Alias so Sonar sees real tests (see src/AGENTS.md). */
const test = Deno.test.bind(Deno);

const FP = "a".repeat(43);
const NEXT = "b".repeat(43);

function pinText(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    current: FP,
    next: NEXT,
    keyset: "2",
    urls: "https://a.example,https://b.example:8443",
    pinned_by: "install",
    updated: "2026-11-01T00:00:00Z",
    ...overrides,
  };
  return Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

test("the pin file parses into its six fields", () => {
  assertEquals(parsePanelIdentityPin(pinText()), {
    current: FP,
    next: NEXT,
    keyset: 2,
    urls: ["https://a.example", "https://b.example:8443"],
    pinnedBy: "install",
    updated: "2026-11-01T00:00:00Z",
  });
  const bare = parsePanelIdentityPin(pinText({ next: "", urls: "" }));
  assertEquals(bare.next, null);
  assertEquals(bare.urls, []);
});

test("an unsafe pin has no current key and nothing else may", () => {
  const unsafe = parsePanelIdentityPin(
    pinText({ current: "", pinned_by: "unsafe" }),
  );
  assertEquals(unsafe.current, "");
  assertThrows(
    () => parsePanelIdentityPin(pinText({ current: "" })),
    TypeError,
  );
});

test("a malformed pin file is refused", () => {
  assertThrows(
    () => parsePanelIdentityPin(pinText().replace(/keyset=.*\n/, "")),
    TypeError,
    "missing keyset",
  );
  assertThrows(
    () => parsePanelIdentityPin(pinText({ keyset: "two" })),
    TypeError,
  );
  assertThrows(
    () => parsePanelIdentityPin(pinText({ current: "a".repeat(42) })),
    TypeError,
  );
  assertThrows(
    () => parsePanelIdentityPin(pinText({ next: "short" })),
    TypeError,
  );
  assertThrows(
    () => parsePanelIdentityPin(pinText({ pinned_by: "x" })),
    TypeError,
  );
  assertThrows(() => parsePanelIdentityPin(pinText() + "extra=1\n"), TypeError);
});

test("reading the pin returns null when absent and the pin when present", async () => {
  const fixture = await createTempLayout();
  try {
    const libDir = `${fixture.env.TURBOPANEL_HOME}/lib`;
    const env = { ...fixture.env, TURBOPANEL_LIB_DIR: libDir };
    assertEquals(await readPanelIdentityPin(env), null);
    await Deno.mkdir(libDir, { recursive: true });
    await Deno.writeTextFile(`${libDir}/${PANEL_IDENTITY_PIN_FILE}`, pinText());
    assertEquals((await readPanelIdentityPin(env))?.current, FP);
  } finally {
    await fixture.cleanup();
  }
});

test("the hello report names how the pin was made", () => {
  assertEquals(panelPinReport(null), undefined);
  assertEquals(panelPinReport(parsePanelIdentityPin(pinText())), {
    pinnedBy: "install",
    current: FP,
    keyset: 2,
  });
});
