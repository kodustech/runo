/** Erro com mensagem acionável — o main imprime message + hint, sem stack trace cru. */
export class RunoError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "RunoError";
    this.hint = hint;
  }
}
