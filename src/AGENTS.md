# Source Tree — AGENTS.md

Daemon repo context: `../AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

## TypeScript style (SonarQube)

- Prefer **`String#replaceAll()`** over **`String#replace()` with a global
  regex** when replacing every occurrence of a substring (`typescript:S7781`).
- Use **`String.raw`** for string literals that contain backslashes so escapes
  stay readable and correct (`typescript:S7780`).
- Prefer **optional chaining** (`obj?.prop`) over `!obj || obj.prop`
  (`typescript:S6582`).
- Use **`new TypeError()`** for type/shape assertions in tests
  (`typescript:S7786`).
- Avoid **nested ternaries** — use `if`/`switch` or helpers
  (`typescript:S3358`).
- Extract helpers when **cognitive complexity** exceeds 15 (`typescript:S3776`).
- Add **`// NOSONAR rule-key — reason`** for intentional read-only `/tmp`
  path-prefix checks (`typescript:S5443`).
- Deno tests: Sonar `typescript:S2187` only recognizes `test()` / `it()` /
  `describe()`, not `Deno.test`. **Every `*.test.ts` file MUST** use BDD
  (`import { describe, it } from '@std/testing/bdd'`) or the canonical alias —
  never leave a bare `Deno.test(` in a test file. Place the alias once, right
  after the imports, and call `test('...', …)` (or the object form
  `test({ name, fn })`):

  ```ts
  /**
   * Jest/Mocha-shaped alias for {@link Deno.test}.
   *
   * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
   * reports Deno suites as empty; keep this alias so analysis sees real tests.
   */
  const test = Deno.test.bind(Deno);
  ```

  When adding a new Deno test file, add this alias from the start. Applied to
  every existing Deno test file in this repo and `../turbopanel`.

- **No flaky tests.** A test gives the same result on every run. No unseeded
  randomness (`crypto.randomUUID`, `Math.random`, random bytes) as input where an
  assertion or a fake keys on the content, prefix, order or collision of the
  value: random hex can contain any short letter run (`dbb`, `bad`, `err`) and
  base64 can contain `+` or `/`, so use a fixed or seeded value. No tight real-time
  margins (a few-millisecond `setTimeout`, an elapsed-time `>=`): wait with
  `waitFor` from `src/testing/wait-for.ts` and a generous ceiling, or inject a
  clock. No wall-clock expectations without a fixed clock (`Date.now()`,
  `new Date()`, midnight, month and DST edges). No order dependence or shared
  module state between tests.
