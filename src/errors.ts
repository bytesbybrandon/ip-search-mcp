export type IpErrorCode =
  | "CREDENTIAL_MISSING"
  | "PROVIDER_DISABLED"
  | "RATE_LIMITED"
  | "UPSTREAM"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "UNSUPPORTED_FORMAT"
  | "CACHE_ERROR";

export class IpError extends Error {
  readonly code: IpErrorCode;
  readonly provider?: string;
  readonly status?: number;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(
    code: IpErrorCode,
    message: string,
    options: { provider?: string; status?: number; hint?: string; details?: unknown } = {},
  ) {
    super(message);
    this.name = "IpError";
    this.code = code;
    this.provider = options.provider;
    this.status = options.status;
    this.hint = options.hint;
    this.details = options.details;
  }
}

export function toErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof IpError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      provider: error.provider,
      status: error.status,
      hint: error.hint,
      details: error.details,
    };
  }
  return {
    ok: false,
    code: "UPSTREAM",
    message: error instanceof Error ? error.message : String(error),
  };
}
