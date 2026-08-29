import pino, { type Logger } from 'pino';
import { REDACTED } from '../crypto.js';

/**
 * Second line of defence behind `SecretString`.
 *
 * This layer is pattern-based, so it can only catch credentials whose *shape* it
 * recognises. It exists to stop a token that reached a log line by accident —
 * through an error message, a third-party library, a raw request body — not to
 * excuse handling secrets as plain strings. `SecretString` is the control;
 * anything this catches is a bug worth fixing at the source.
 *
 * Each pattern keeps its prefix in the output (`sk-ant-[redacted]`) so an
 * operator can tell what kind of credential leaked and go fix the call site,
 * without the log line containing any of the secret material.
 */
interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * Order matters: `sk-ant-` must be tried before the generic `sk-`, or an
 * Anthropic key would be reported as an OpenAI-shaped one.
 */
const RULES: readonly RedactionRule[] = [
  {
    name: 'anthropic',
    pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g,
    replacement: `sk-ant-${REDACTED}`,
  },
  {
    name: 'github-fine-grained-pat',
    pattern: /github_pat_[A-Za-z0-9_]{16,}/g,
    replacement: `github_pat_${REDACTED}`,
  },
  {
    name: 'github-classic-pat',
    pattern: /ghp_[A-Za-z0-9]{16,}/g,
    replacement: `ghp_${REDACTED}`,
  },
  {
    name: 'github-oauth',
    pattern: /gho_[A-Za-z0-9]{16,}/g,
    replacement: `gho_${REDACTED}`,
  },
  {
    name: 'generic-sk',
    pattern: /sk-[A-Za-z0-9_-]{16,}/g,
    replacement: `sk-${REDACTED}`,
  },
  {
    // A JWT header is base64url of `{"alg"...`, which always starts `eyJ`. That
    // anchor is what keeps this from matching ordinary dotted identifiers.
    name: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
    replacement: `[redacted-jwt]`,
  },
];

/** Scrubs recognised credential shapes out of arbitrary text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/** True when `text` still contains something this layer would redact. */
export function containsRedactableSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}

/**
 * Wraps a writable so every line pino emits is scrubbed on the way out.
 *
 * Applied at the destination rather than as a pino `logMethod` hook or a `redact`
 * path list, because by this point the record is fully serialised: the scrub sees
 * message strings, nested object values, error stacks, and serialiser output
 * alike, without needing to know which key a secret ended up under.
 */
export function createRedactingDestination(
  target: { write(chunk: string): void } = process.stdout,
): { write(chunk: string): void } {
  return {
    write(chunk: string): void {
      target.write(redactSecrets(chunk));
    },
  };
}

/**
 * The application logger: pino, writing through {@link createRedactingDestination}.
 *
 * `redact` covers the obvious key names; the destination covers everything else,
 * including values nested where no path list would find them.
 */
export function createRedactedLogger(
  target: { write(chunk: string): void } = process.stdout,
): Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['password', 'token', 'secret', '*.password', '*.token', '*.secret'],
    },
    createRedactingDestination(target),
  );
}
