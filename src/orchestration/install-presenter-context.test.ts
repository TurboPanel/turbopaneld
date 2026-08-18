import { assertEquals } from "@std/assert";
import {
  getActiveInstallPresenter,
  isInstallPresenterActive,
  InstallerPresentedFailure,
  setActiveInstallPresenter,
} from "./install-presenter-context.ts";
import { InstallPresenter } from "./install-presenter.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("setActiveInstallPresenter toggles active presenter state", () => {
  const presenter = new InstallPresenter(false);
  try {
    assertEquals(getActiveInstallPresenter(), null);
    assertEquals(isInstallPresenterActive(), false);

    setActiveInstallPresenter(presenter);
    assertEquals(getActiveInstallPresenter(), presenter);
    assertEquals(isInstallPresenterActive(), true);

    setActiveInstallPresenter(null);
    assertEquals(getActiveInstallPresenter(), null);
    assertEquals(isInstallPresenterActive(), false);
  } finally {
    presenter.dispose();
    setActiveInstallPresenter(null);
  }
});

test("InstallerPresentedFailure uses a stable name and message", () => {
  const err = new InstallerPresentedFailure();
  assertEquals(err.name, "InstallerPresentedFailure");
  assertEquals(err.message, "installer failed");
});
