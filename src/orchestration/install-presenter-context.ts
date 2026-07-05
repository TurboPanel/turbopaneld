import type { InstallPresenter } from "./install-presenter.ts";

let activePresenter: InstallPresenter | null = null;

/** Thrown after {@link InstallPresenter.fail} has already rendered the failure. */
export class InstallerPresentedFailure extends Error {
  constructor() {
    super("installer failed");
    this.name = "InstallerPresentedFailure";
  }
}

export function setActiveInstallPresenter(presenter: InstallPresenter | null): void {
  activePresenter = presenter;
}

export function getActiveInstallPresenter(): InstallPresenter | null {
  return activePresenter;
}

export function isInstallPresenterActive(): boolean {
  return activePresenter !== null;
}
