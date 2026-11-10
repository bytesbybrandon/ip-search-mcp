export class AxiError extends Error {
  readonly exitCode: number = 1;
  readonly suggestion?: string;

  constructor(message: string, suggestion?: string) {
    super(message);
    this.suggestion = suggestion;
  }
}

export class UsageError extends AxiError {
  override readonly exitCode: number = 2;
}

export function renderError(error: AxiError): string {
  const lines = [`error: ${error.message}`];
  if (error.suggestion) lines.push(`suggestion: ${error.suggestion}`);
  return lines.join("\n");
}
