import pino, { type Logger, type LoggerOptions } from 'pino';
import type { FastifyReply, FastifyRequest } from 'fastify';
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

// ─── Base path elision ───────────────────────────────────────────────────────

/**
 * What the secret base path is replaced with in every log line. A fixed literal,
 * so `/<base>/api/foo` is a stable, greppable shape and the real value never
 * reaches the log at all — not even in a shortened or hashed form, which would
 * still be a per-install identifier.
 */
export const BASE_PATH_PLACEHOLDER = '<base>';

/** Escapes a string so it can be embedded in a RegExp as a literal. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A no-op elider, for the case where there is nothing to elide. */
const IDENTITY = (text: string): string => text;

/**
 * Builds a function that replaces every spelling of `basePath` with
 * {@link BASE_PATH_PLACEHOLDER}.
 *
 * Three spellings are covered, because a log line is JSON and a URL is
 * percent-encodable:
 *
 * - the raw value, which is what a matching `req.url` contains;
 * - the JSON-escaped body of the value, which is what pino writes when the base
 *   path contains a quote or a backslash (`PANEL_BASE_PATH` is operator-supplied
 *   and unvalidated, so it can);
 * - the percent-encoded value, for a URL that reached a log line after encoding.
 *
 * Longest first, so a spelling that is a prefix of another cannot shadow it.
 *
 * The match is on the bare base path rather than on `/<basePath>`, so the value
 * is also caught where it appears without a leading slash — a cookie `Path`
 * attribute, an `instance.json` dump, a hand-built string. The cost is that a
 * very short `PANEL_BASE_PATH` will also match unrelated text in a log line;
 * that is the correct trade for a value that must not be printed.
 */
export function createBasePathElider(
  basePath: string,
  placeholder: string = BASE_PATH_PLACEHOLDER,
): (text: string) => string {
  const spellings = new Set(
    [basePath, JSON.stringify(basePath).slice(1, -1), encodeURIComponent(basePath)].filter(
      (spelling) => spelling.length > 0,
    ),
  );
  if (spellings.size === 0) return IDENTITY;

  const pattern = new RegExp(
    [...spellings]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|'),
    'g',
  );

  // A function replacement, not a string: `$&` and friends are special in a
  // string replacement and a caller-supplied placeholder must not be able to
  // reintroduce the matched text.
  return (text: string): string => text.replace(pattern, () => placeholder);
}

// ─── Destination and logger ──────────────────────────────────────────────────

export interface LoggerRedactionOptions {
  /**
   * The secret base path. When given, every spelling of it is elided from every
   * log line and from the `req` serialiser's `url`.
   */
  readonly basePath?: string;
  /**
   * Extra literal values to elide from every log line, whatever they look like.
   *
   * For a secret this process knows at boot and no pattern would recognise. The one
   * caller today is `PANEL_OUTBOUND_PROXY`, which may carry `user:password@host`
   * credentials and would otherwise be a plain string in whatever error a failed
   * dispatch produces. Values shorter than {@link MIN_ELIDABLE_LENGTH} are ignored: a
   * four-character literal would match unrelated text in half the lines and the result
   * would be unreadable rather than redacted.
   */
  readonly elide?: readonly string[];
  /** Where scrubbed lines go. Defaults to `process.stdout`. */
  readonly target?: { write(chunk: string): void };
}

/** Below this length an elided literal does more damage than the leak it prevents. */
export const MIN_ELIDABLE_LENGTH = 8;

/**
 * One function that applies the base-path elision and every extra literal.
 *
 * Built as a chain rather than one alternating pattern so each value keeps its own
 * placeholder: the base path reads as `<base>` (a shape worth grepping for) and a
 * credential reads as `[redacted]` (a value that should not be there at all).
 */
function createEliderChain(opts: LoggerRedactionOptions): (text: string) => string {
  const steps: ((text: string) => string)[] = [];
  if (opts.basePath !== undefined && opts.basePath.length > 0) {
    steps.push(createBasePathElider(opts.basePath));
  }
  for (const value of opts.elide ?? []) {
    if (value.length < MIN_ELIDABLE_LENGTH) continue;
    steps.push(createBasePathElider(value, REDACTED));
  }
  if (steps.length === 0) return IDENTITY;
  return (text: string): string => steps.reduce((acc, step) => step(acc), text);
}

/**
 * Wraps a writable so every line pino emits is scrubbed on the way out.
 *
 * Applied at the destination rather than as a pino `logMethod` hook or a `redact`
 * path list, because by this point the record is fully serialised: the scrub sees
 * message strings, nested object values, error stacks, and serialiser output
 * alike, without needing to know which key a secret ended up under.
 *
 * That property is exactly why the base path elision is applied here too. A
 * `req` serialiser only covers `req.url`; this covers the request log line, the
 * response log line, an error message, a stack frame, and any string a call site
 * built by hand.
 */
export function createRedactingDestination(
  opts: LoggerRedactionOptions = {},
): { write(chunk: string): void } {
  const target = opts.target ?? process.stdout;
  const elide = createEliderChain(opts);

  return {
    write(chunk: string): void {
      target.write(elide(redactSecrets(chunk)));
    },
  };
}

/**
 * Pino serialisers that elide the base path from the structured fields Fastify
 * logs.
 *
 * Fastify's own `req` serialiser writes `req.url` verbatim, which is how the
 * secret base path ends up in the retained log of every valid request. These
 * replace it. Fastify merges an instance's own serialisers over its defaults
 * (`lib/logger-pino.js`), so setting them on the pino instance is what wins.
 *
 * This is the structural control; the destination scrub above is the catch-all.
 */
export function createBasePathSerializers(
  basePath: string,
): NonNullable<LoggerOptions['serializers']> {
  const elide = createBasePathElider(basePath);

  return {
    req: (req: FastifyRequest) => ({
      method: req.method,
      url: elide(req.url),
      version: req.headers['accept-version'],
      host: req.host,
      // Recorded, never used to decide anything. See docs/SECURITY.md.
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    }),
    res: (reply: FastifyReply) => ({ statusCode: reply.statusCode }),
    err: (err: Error) => {
      const serialised = pino.stdSerializers.err(err) as Record<string, unknown>;
      const out: Record<string, unknown> = { ...serialised };
      if (typeof out.message === 'string') out.message = elide(out.message);
      if (typeof out.stack === 'string') out.stack = elide(out.stack);
      return out;
    },
  };
}

/**
 * The application logger: pino, writing through {@link createRedactingDestination}.
 *
 * `redact` covers the obvious key names; the serialisers cover Fastify's
 * structured request/response/error fields; the destination covers everything
 * else, including values nested where no path list would find them.
 */
export function createRedactedLogger(opts: LoggerRedactionOptions = {}): Logger {
  const serializers =
    opts.basePath === undefined ? undefined : createBasePathSerializers(opts.basePath);

  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['password', 'token', 'secret', '*.password', '*.token', '*.secret'],
      ...(serializers ? { serializers } : {}),
    },
    createRedactingDestination(opts),
  );
}

