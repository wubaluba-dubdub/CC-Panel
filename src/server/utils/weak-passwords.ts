/**
 * The minimum a password must clear, both for the seeded admin password and for
 * every later change. Shared so the two cannot drift apart — a change endpoint
 * that accepted weaker passwords than boot validation would quietly undo it.
 */

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Passwords rejected outright.
 *
 * A deliberately tiny list, not a dictionary: it exists to catch the handful of
 * strings someone types when they intend to "fix the password later", all of
 * which already clear the length floor. Compared lower-cased, so case variations
 * are covered too. Real strength comes from the length requirement and from the
 * argon2id cost, not from list membership.
 */
export const WEAK_PASSWORDS: readonly string[] = [
  'password123456',
  'admin123456789',
  'letmein1234567',
  'welcome1234567',
  'monkey12345678',
  'master12345678',
  'qwerty12345678',
  'abc123456789ab',
  'password1234567',
  'changeme123456',
];

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

/** Throws {@link WeakPasswordError} when `password` does not clear the policy. */
export function assertStrongPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (WEAK_PASSWORDS.includes(password.toLowerCase())) {
    throw new WeakPasswordError('password is too weak (matches known-weak list)');
  }
}
