/** Error with an actionable message — main prints message + hint, no raw stack trace. */
export class RunoError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "RunoError";
    this.hint = hint;
  }
}
