import express, { type Request, type RequestHandler } from 'express';
import { env } from '../config/env';

/**
 * Captures the request body as bytes.
 *
 * Signature verification has to run over the exact bytes that were sent - a
 * parsed-and-reserialized object differs in key order, whitespace and unicode
 * escaping, so it would never produce a matching HMAC. Mount this on webhook
 * routes *before* any JSON parser.
 */
export function rawBodyParser(limit = '1mb'): RequestHandler {
  return express.raw({ type: '*/*', limit });
}

export function rawBodyOf(req: Request): string {
  return Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
}

export function parseJsonBody<T>(req: Request): T | null {
  const raw = rawBodyOf(req);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * The URI as HubSpot saw it. Built from BASE_URL rather than the Host header so
 * a proxy rewriting the host can't silently break signature verification.
 */
export function publicUrlOf(req: Request): string {
  return `${env.BASE_URL}${req.originalUrl}`;
}
