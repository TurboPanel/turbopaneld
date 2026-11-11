/**
 * An error that carries a stable code and a small details record beside its
 * sentence. Raised in process; a command outcome carries only the sentence
 * today, so nothing here reaches the control plane until the outcome grows a
 * place for details.
 */
export class StructuredCommandError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    code: string,
    details: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "StructuredCommandError";
    this.code = code;
    this.details = details;
  }
}
