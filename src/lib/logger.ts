import pino from 'pino';
import { env } from '../config/env';

const usePretty = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: undefined,
  redact: {
    paths: [
      'accessToken',
      'refreshToken',
      'apiKey',
      'api_key',
      'webhookSecret',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.accessToken',
      '*.refreshToken',
      '*.apiKey',
    ],
    censor: '[redacted]',
  },
  ...(usePretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
