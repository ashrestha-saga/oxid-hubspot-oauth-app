import type { ErrorRequestHandler, RequestHandler } from 'express';
import { env } from '../config/env';
import { isAppError } from '../lib/errors';
import { logger } from '../lib/logger';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: 'not_found', message: `${req.method} ${req.path} is not a route` });
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const status = isAppError(error) ? error.status : 500;
  const code = isAppError(error) ? error.code : 'internal_error';
  const message = error instanceof Error ? error.message : 'unexpected error';

  const log = status >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
  log({ err: error, method: req.method, path: req.path, status, code }, 'request failed');

  if (res.headersSent) return;

  res.status(status).json({
    error: code,
    message,
    ...(isAppError(error) && error.details ? { details: error.details } : {}),
    ...(env.NODE_ENV === 'development' && error instanceof Error ? { stack: error.stack } : {}),
  });
};
