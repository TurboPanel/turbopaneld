/**
 * Answering HTTP-01 checks through the server's proof socket.
 *
 * The server-placed order path already routes `/.well-known/acme-challenge/*`
 * for the order's names to `<run>/tenant-acme-<request>.sock` inside each
 * site's own port-80 block, and every helper server forwards the same path to
 * this one (`acme-proof-forward.ts`). This module serves the key
 * authorizations of one order on that socket, so the daemon's own client can
 * be answered over exactly the routes the one-shot issuer uses today.
 */
import {
  type InstanceAcmeCommand,
  type ProofAnswer,
  withProofAnswerServer,
} from "../instance-acme-http01.ts";
import type { ChallengeSolver } from "./order.ts";

const CHALLENGE_PREFIX = "/.well-known/acme-challenge/";
const TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;

/** The answers of one order, by token, and the solver that fills them. */
export class Http01Answers {
  readonly #answers = new Map<string, string>();

  readonly solver: ChallengeSolver = {
    type: "http-01",
    present: ({ token, value }) => {
      if (!TOKEN_RE.test(token)) {
        return Promise.reject(
          new TypeError("the challenge token is not usable"),
        );
      }
      this.#answers.set(token, value);
      return Promise.resolve();
    },
    remove: ({ token }) => {
      this.#answers.delete(token);
      return Promise.resolve();
    },
  };

  /** How the socket answers a request path: the key authorization, or 404. */
  readonly answer: ProofAnswer = (path) => {
    const token = path.startsWith(CHALLENGE_PREFIX)
      ? path.slice(CHALLENGE_PREFIX.length)
      : "";
    const value = this.#answers.get(token);
    return value === undefined
      ? { status: 404, body: "" }
      : { status: 200, body: value };
  };

  get size(): number {
    return this.#answers.size;
  }
}

/**
 * Serve an order's HTTP-01 answers on `socketPath` while `work` runs. The
 * socket is opened to the hosting web server the same way the preflight
 * socket is (`tp-host setfacl`, exactly the `tenant-acme-<id>.sock` shape).
 */
export function withHttp01Answers<T>(
  socketPath: string,
  run: InstanceAcmeCommand,
  work: (solver: ChallengeSolver) => Promise<T>,
): Promise<T> {
  const answers = new Http01Answers();
  return withProofAnswerServer(
    socketPath,
    answers.answer,
    run,
    () => work(answers.solver),
  );
}
