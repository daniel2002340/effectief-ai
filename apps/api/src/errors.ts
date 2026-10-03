import type { ErrorCode, ErrorIssue, ErrorResponse } from '@effectief/shared';

export const statusByCode: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

/** Default user-facing messages, in Dutch. */
export const messageByCode: Record<ErrorCode, string> = {
  BAD_REQUEST: 'Het verzoek is ongeldig.',
  VALIDATION_FAILED: 'Niet alle gegevens zijn goed ingevuld.',
  UNAUTHORIZED: 'Je bent niet ingelogd.',
  FORBIDDEN: 'Je hebt geen toegang tot dit onderdeel.',
  NOT_FOUND: 'Niet gevonden.',
  CONFLICT: 'Dit is intussen door iemand anders gewijzigd.',
  PAYLOAD_TOO_LARGE: 'Het verzoek is te groot.',
  UNSUPPORTED_MEDIA_TYPE: 'Dit formaat wordt niet ondersteund.',
  RATE_LIMITED: 'Te veel verzoeken. Probeer het over een minuut opnieuw.',
  INTERNAL_ERROR: 'Er ging iets mis. Probeer het later opnieuw.',
  SERVICE_UNAVAILABLE: 'De dienst is tijdelijk niet beschikbaar.',
};

/** An error we throw on purpose; its message is safe to show to the user. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly issues: ErrorIssue[] | undefined;

  constructor(code: ErrorCode, options: { message?: string; issues?: ErrorIssue[] } = {}) {
    super(options.message ?? messageByCode[code]);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusByCode[code];
    this.issues = options.issues;
  }
}

export function codeForStatus(status: number): ErrorCode {
  const match = (Object.entries(statusByCode) as [ErrorCode, number][]).find(
    ([code, value]) => value === status && code !== 'VALIDATION_FAILED',
  );
  if (match) return match[0];
  return status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
}

export function errorBody(
  code: ErrorCode,
  requestId: string,
  options: { message?: string; issues?: ErrorIssue[] | undefined } = {},
): ErrorResponse {
  return {
    error: {
      code,
      message: options.message ?? messageByCode[code],
      requestId,
      ...(options.issues ? { issues: options.issues } : {}),
    },
  };
}
