/**
 * Test double for the demoted fence's `config/my.cnf` helper containers:
 * `--entrypoint cat` reads the simulated file, the `sh -c … mv -f …` writer
 * replaces it with its last argument. Every other docker call succeeds with
 * empty output unless `fallback` answers it.
 */

import type { DockerCliResult } from "../deploy/docker-cli.ts";

export type FakeMysqlCnfDocker = {
  run: (args: string[]) => Promise<DockerCliResult>;
  calls: string[][];
  /** Current simulated `my.cnf` content. */
  content: () => string;
  writes: () => number;
};

export type FakeMysqlCnfDockerOptions = {
  readFails?: boolean;
  writeFails?: boolean;
  /** Writer reports success but the file keeps its old content. */
  writeIsLost?: boolean;
  fallback?: (args: string[]) => Promise<DockerCliResult> | undefined;
};

function ok(stdout = ""): Promise<DockerCliResult> {
  return Promise.resolve({ success: true, code: 0, stdout, stderr: "" });
}

function failed(stderr: string): Promise<DockerCliResult> {
  return Promise.resolve({ success: false, code: 1, stdout: "", stderr });
}

function isCnfRead(args: string[]): boolean {
  return args[0] === "run" && args.includes("--entrypoint") &&
    args[args.indexOf("--entrypoint") + 1] === "cat";
}

function isCnfWrite(args: string[]): boolean {
  return args[0] === "run" &&
    args.some((arg) => arg.includes("mv -f") && arg.includes("my.cnf"));
}

export function fakeMysqlCnfDocker(
  initial: string,
  options: FakeMysqlCnfDockerOptions = {},
): FakeMysqlCnfDocker {
  let content = initial;
  let writes = 0;
  const calls: string[][] = [];
  const run = (args: string[]): Promise<DockerCliResult> => {
    calls.push(args);
    if (isCnfRead(args)) {
      return options.readFails ? failed("cat failed") : ok(content);
    }
    if (isCnfWrite(args)) {
      if (options.writeFails) return failed("write failed");
      writes++;
      if (!options.writeIsLost) content = args.at(-1) ?? "";
      return ok();
    }
    return options.fallback?.(args) ?? ok();
  };
  return { run, calls, content: () => content, writes: () => writes };
}
