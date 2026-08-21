export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** Whether a queued job that failed with this error is worth retrying. */
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      details?: unknown;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status ?? 500;
    this.code = options.code ?? 'internal_error';
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { status: 400, code: 'bad_request', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'unauthorized') {
    super(message, { status: 401, code: 'unauthorized' });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'not found') {
    super(message, { status: 404, code: 'not_found' });
  }
}

export class IntegrationNotReadyError extends AppError {
  constructor(message: string) {
    super(message, { status: 409, code: 'integration_not_ready' });
  }
}

/** A downstream API (HubSpot or OXID) failed. Retryable for 429/5xx. */
export class ExternalApiError extends AppError {
  constructor(
    message: string,
    options: { system: 'hubspot' | 'oxid'; status?: number; details?: unknown; cause?: unknown },
  ) {
    const upstream = options.status ?? 0;
    super(message, {
      status: 502,
      code: `${options.system}_api_error`,
      details: { upstreamStatus: upstream, ...(options.details ? { body: options.details } : {}) },
      retryable: upstream === 429 || upstream === 0 || upstream >= 500,
      cause: options.cause,
    });
  }
}

export class NotImplementedError extends AppError {
  constructor(what: string) {
    super(`${what} is not implemented yet`, { status: 501, code: 'not_implemented' });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function describeError(error: unknown): { message: string; stack?: string; code?: string } {
  if (isAppError(error)) {
    return { message: error.message, code: error.code, stack: error.stack };
  }
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}
