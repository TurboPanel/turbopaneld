import { assertEquals, assertRejects } from "@std/assert";
import {
  assertNoViewsDefinedBy,
  dropUserOnEveryHost,
  LoginOwnsViewsError,
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
            sql.includes("information_schema.VIEWS")
              ? "shop\torders_v\nshop\tcustomers_v\n"
              : "%\n",
          ),
        run: (sql) => {
          ran.push(sql);
          return Promise.resolve();
        },
        dropAccountSql: () => "DROP USER x;",
      }),
    LoginOwnsViewsError,
    "shop.orders_v, shop.customers_v",
  );
  assertEquals((error as LoginOwnsViewsError).views.length, 2);
  assertEquals(ran, []);
});

test("dropUserOnEveryHost drops a login that defines no views", async () => {
  const ran: string[] = [];
  await dropUserOnEveryHost({
    username: "app_user",
    fixedHosts: ["localhost"],
    quoteLiteral: quote,
    query: (sql) =>
      Promise.resolve(sql.includes("information_schema.VIEWS") ? "" : "%\n"),
    run: (sql) => {
      ran.push(sql);
      return Promise.resolve();
    },
    dropAccountSql: () => "DROP USER x;",
  });
  assertEquals(ran, ["DROP USER x;"]);
});

test("assertNoViewsDefinedBy caps a long view list", async () => {
  const lines = Array.from({ length: 14 }, (_, i) => `db\tv${i}`).join("\n");
  const error = await assertRejects(
    () =>
      assertNoViewsDefinedBy({
        username: "u",
        quoteLiteral: quote,
        query: () => Promise.resolve(lines),
      }),
    LoginOwnsViewsError,
    "and 4 more",
  );
  assertEquals((error as LoginOwnsViewsError).views.length, 11);
});
