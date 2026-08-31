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
