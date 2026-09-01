import 'dotenv/config';
import { z } from 'zod';

const base64Key32 = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      return Buffer.from(value, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'must be a base64-encoded 32-byte key');

const csvList = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BASE_URL: z.string().url(),

  DATABASE_URL: z.string().min(1),

  HUBSPOT_CLIENT_ID: z.string().min(1),
  HUBSPOT_CLIENT_SECRET: z.string().min(1),
  /** Optional; defaults to `${BASE_URL}/oauth/callback` so OAuth steps cannot drift apart. */
  HUBSPOT_REDIRECT_URI: z.string().url().optional(),
  HUBSPOT_SCOPES: csvList,
  HUBSPOT_APP_ID: z.string().optional(),
  HUBSPOT_DEVELOPER_API_KEY: z.string().optional(),

  TOKEN_ENCRYPTION_KEY: base64Key32,
  SESSION_SIGNING_KEY: base64Key32,

  OXID_CLIENT_MODE: z.enum(['stub', 'oxapi']).default('stub'),
  /** Optional; defaults to `${BASE_URL}/oxid/oauth/callback`. */
  OXID_OAUTH_REDIRECT_URI: z.string().url().optional(),
  OXID_OAUTH_SCOPES: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? 'profile,address,api')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),

  RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(15),
  RUN_WORKER_IN_WEB: booleanish.default('true'),
  SYNC_WORKER_POLL_MS: z.coerce.number().int().min(250).default(2000),
  SYNC_JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
});

export type Env = z.infer<typeof envSchema> & {
  BASE_URL: string;
  HUBSPOT_REDIRECT_URI: string;
  OXID_OAUTH_REDIRECT_URI: string;
};

function load(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const BASE_URL = parsed.data.BASE_URL.replace(/\/+$/, '');
  const HUBSPOT_REDIRECT_URI =
    parsed.data.HUBSPOT_REDIRECT_URI?.replace(/\/+$/, '') ?? `${BASE_URL}/oauth/callback`;
  const OXID_OAUTH_REDIRECT_URI =
    parsed.data.OXID_OAUTH_REDIRECT_URI?.replace(/\/+$/, '') ?? `${BASE_URL}/oxid/oauth/callback`;

  if (HUBSPOT_REDIRECT_URI !== `${BASE_URL}/oauth/callback`) {
    throw new Error(
      `Invalid environment configuration:\n` +
        `  - HUBSPOT_REDIRECT_URI must be ${BASE_URL}/oauth/callback (derived from BASE_URL). ` +
        `Got ${HUBSPOT_REDIRECT_URI}. Remove HUBSPOT_REDIRECT_URI from .env or fix BASE_URL.`,
    );
  }

  // BASE_URL is used verbatim to rebuild the URI HubSpot signed, so a trailing
  // slash there would silently break every webhook signature check.
  return { ...parsed.data, BASE_URL, HUBSPOT_REDIRECT_URI, OXID_OAUTH_REDIRECT_URI };
}

export const env = load();
