/**
 * Managed-engine runtime registry.
 *
 * Extension rule: one engine file + one entry here.
 */

import type { ManagedEngineCode } from "../../instance/commands/contracts.ts";
import { mariadbManagedEngineRuntime } from "./mariadb.ts";
import { mysqlManagedEngineRuntime } from "./mysql.ts";
import { postgresManagedEngineRuntime } from "./postgres.ts";
import {
  ManagedEngineNotSupportedError,
  type ManagedEngineRuntime,
} from "./types.ts";

const RUNTIMES: Partial<Record<ManagedEngineCode, ManagedEngineRuntime>> = {
  postgres: postgresManagedEngineRuntime,
  mysql: mysqlManagedEngineRuntime,
  mariadb: mariadbManagedEngineRuntime,
};

export function getManagedEngineRuntime(
  code: ManagedEngineCode,
): ManagedEngineRuntime {
  const runtime = RUNTIMES[code];
  if (!runtime) {
    throw new ManagedEngineNotSupportedError(code);
  }
  return runtime;
}

export type { ManagedEngineContext, ManagedEngineRuntime } from "./types.ts";
export { ManagedEngineNotSupportedError } from "./types.ts";
