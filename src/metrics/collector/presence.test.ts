import { assertEquals } from "@std/assert";
import { PRESENCE_WINDOW_SAMPLES, PresenceTracker } from "./presence.ts";

const test = Deno.test.bind(Deno);

test("a series stays present until it has been null for the whole window", () => {
  const tracker = new PresenceTracker();
  for (let i = 0; i < PRESENCE_WINDOW_SAMPLES - 1; i++) {
    assertEquals(tracker.observe("gpu:a", false), true);
  }
  assertEquals(tracker.observe("gpu:a", false), false);
  assertEquals(tracker.observe("gpu:a", false), false);
});

test("one value brings a dropped series back and restarts the window", () => {
  const tracker = new PresenceTracker();
  for (let i = 0; i < PRESENCE_WINDOW_SAMPLES; i++) {
    tracker.observe("s", false);
  }
  assertEquals(tracker.observe("s", true), true);
  assertEquals(tracker.observe("s", false), true);
});

test("filter keeps entities with a value and entities still inside the window", () => {
  const tracker = new PresenceTracker();
  const items = [{ id: "a", v: 1 }, { id: "b", v: null }];
  const has = (x: { v: number | null }) => x.v !== null;
  for (let i = 0; i < PRESENCE_WINDOW_SAMPLES - 1; i++) {
    assertEquals(tracker.filter(items, (x) => x.id, has).length, 2);
  }
  assertEquals(tracker.filter(items, (x) => x.id, has), [items[0]]);
});
