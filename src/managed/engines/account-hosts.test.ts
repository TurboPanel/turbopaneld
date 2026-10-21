import { assertEquals, assertRejects } from "@std/assert";
import {
  assertNoObjectsDefinedBy,
  definerObjectsSql,
  dropUserOnEveryHost,
  LoginOwnsObjectsError,
} from "./account-hosts.ts";

const test = Deno.test.bind(Deno);
const quote = (value: string) => `'${value}'`;

test("dropUserOnEveryHost refuses a login that defines views and names them", async () => {
  const ran: string[] = [];
  const error = await assertRejects(
    () =>
      dropUserOnEveryHost({
        username: "app_user",
        fixedHosts: ["localhost"],
        quoteLiteral: quote,
        query: (sql) =>
          Promise.resolve(
            sql.includes("information_schema.TRIGGERS")
              ? "app_user\tview\tshop\torders_v\napp_user\troutine\tshop\trecalc\n"
              : "%\n",
          ),
        run: (sql) => {
          ran.push(sql);
          return Promise.resolve();
        },
        dropAccountSql: () => "DROP USER x;",
      }),
    LoginOwnsObjectsError,
    "'view shop.orders_v', 'routine shop.recalc'",
  );
  assertEquals((error as LoginOwnsObjectsError).objects.length, 2);
  assertEquals(ran, []);
});

test("dropUserOnEveryHost drops a login that defines no views", async () => {
  const ran: string[] = [];
  await dropUserOnEveryHost({
    username: "app_user",
    fixedHosts: ["localhost"],
    quoteLiteral: quote,
    query: (sql) =>
      Promise.resolve(sql.includes("information_schema.TRIGGERS") ? "" : "%\n"),
    run: (sql) => {
      ran.push(sql);
      return Promise.resolve();
    },
    dropAccountSql: () => "DROP USER x;",
  });
  assertEquals(ran, ["DROP USER x;"]);
});

test("assertNoObjectsDefinedBy caps a long view list", async () => {
  const lines = Array.from({ length: 14 }, (_, i) => `u\tview\tdb\tv${i}`).join(
    "\n",
  );
  const error = await assertRejects(
    () =>
      assertNoObjectsDefinedBy({
        username: "u",
        quoteLiteral: quote,
        query: () => Promise.resolve(lines),
      }),
    LoginOwnsObjectsError,
    "and 4 more",
  );
  assertEquals((error as LoginOwnsObjectsError).objects.length, 11);
});

test("assertNoObjectsDefinedBy ignores rows that belong to another login", async () => {
  await assertNoObjectsDefinedBy({
    username: "app_user",
    quoteLiteral: quote,
    query: () => Promise.resolve("other\tevent\tshop\tnightly\n"),
  });
});

test("definerObjectsSql looks at views, triggers, routines and events", () => {
  const sql = definerObjectsSql(["a", "b"], quote);
  for (const table of ["VIEWS", "TRIGGERS", "ROUTINES", "EVENTS"]) {
    assertEquals(sql.includes(`information_schema.${table}`), true);
  }
  assertEquals(sql.includes("IN ('a', 'b')"), true);
});
