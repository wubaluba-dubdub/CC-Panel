import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from './weak-passwords.js';
import { HttpError } from '../plugins/auth.js';

/**
 * Request body schemas.
 *
 * Bounded on purpose: an upper length on every field keeps a megabyte of
 * "password" out of argon2, which would otherwise be a cheap way to make the
 * server do expensive work. The global `bodyLimit` is the outer bound; these are
 * the inner ones.
 */

export const usernameSchema = z.string().min(1).max(128);

/**
 * No `.min(MIN_PASSWORD_LENGTH)` on the *login* password: rejecting a short
 * password at the schema means a short guess returns instantly, without the
 * argon2 verification, which is a length oracle and also skips the delay. Login
 * accepts any non-empty password and lets it fail the hash comparison like any
 * other wrong one.
 */
export const loginPasswordSchema = z.string().min(1).max(1024);

/** For *setting* a password, where the policy does apply. */
export const newPasswordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(1024);

/**
 * The second-factor field. Either a six-digit TOTP code or a recovery code, so it
 * cannot be pinned to six digits here.
 */
export const authCodeSchema = z.string().min(1).max(64);

export const loginBody = z.object({
  username: usernameSchema,
  password: loginPasswordSchema,
});

export const codeBody = z.object({
  code: authCodeSchema,
});

export const stepUpBody = z.object({
  password: loginPasswordSchema,
  code: authCodeSchema,
});

export const changePasswordBody = z.object({
  newPassword: newPasswordSchema,
});

export const secretRefBody = z.object({
  scope: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
});

export const secretSetBody = secretRefBody.extend({
  value: z.string().min(1).max(8192),
});

export const sessionIdParams = z.object({
  id: z.coerce.number().int().positive(),
});

export const queueIdParams = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * The audit query string.
 *
 * `limit` is capped here as well as in the service: the query is authenticated, but
 * "authenticated" is not "allowed to ask for a million rows in one response".
 * `event` accepts either one value or several (`?event=a&event=b`, which Fastify
 * hands over as an array), and the ISO bounds are validated as datetimes so a
 * malformed `from` is a 400 rather than a silently empty page.
 */
export const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  event: z
    .union([z.string().min(1).max(64), z.array(z.string().min(1).max(64)).max(32)])
    .optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/**
 * The one setting the client may write.
 *
 * A closed enum rather than a string, because it is written straight into a `CHECK`
 * constrained column and because there are exactly two dictionaries. An unknown locale is a
 * 400 rather than a stored value nothing can render.
 */
export const localeBody = z.object({
  locale: z.enum(['en', 'fa']),
});

/**
 * Parses a request body, turning a schema failure into a 400 with the standard
 * reason phrase and nothing else.
 *
 * Zod's own message names the failing field and its constraint. On an
 * authentication endpoint that is a free hint about what the server expects, and
 * the app's error handler already collapses every body to the status's reason
 * phrase — this keeps the detail out of the log line too.
 */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, 'invalid request body');
  return result.data as z.infer<T>;
}
