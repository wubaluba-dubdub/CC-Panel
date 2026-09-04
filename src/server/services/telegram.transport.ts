import { randomBytes } from 'node:crypto';
import type { SecretString } from '../crypto.js';
import {
  OutboundUnreachableError,
  createOutboundFetch,
  type OutboundFetch,
} from '../utils/outbound-http.js';

/**
 * The Telegram Bot API, and the six things about it that each cost a debugging session.
 *
 * **This is the only file in `src/` that may name `api.telegram.org`.** A static scan in
 * `tests/integration/notifications.test.ts` enforces it, for the same reason
 * `plugins/cookies.ts` is the only file that may name a cookie: the URL contains the bot
 * token in its *path*, so every place that builds one is a place that can log one.
 */

/** Overridable only so the tests can point at a local fake server. */
export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';

/**
 * Telegram's hard limit on `sendMessage.text`, in **characters**.
 *
 * It rejects the whole request rather than truncating, and a Claude Code turn summary
 * will exceed it regularly.
 */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** How far back from the cut a newline is worth looking for, in code points. */
const NEWLINE_SEARCH_WINDOW = 200;

export type TelegramRejection =
  /** 401. The token is wrong, or was revoked with /revoke in BotFather. */
  | 'bad_token'
  /** 400 `chat not found`. The id is wrong, or belongs to another bot's chat. */
  | 'unknown_chat'
  /** 403. The recipient has never pressed Start, or has blocked the bot. */
  | 'not_started'
  /** 429. Honour `parameters.retry_after`, which is authoritative. */
  | 'rate_limited'
  /** 409 from `getUpdates` while a webhook is set. Only discovery can see this. */
  | 'webhook_active'
  | 'other';

export type TransportFailure =
  /** No bot token or no chat id stored. Not an error — a state. */
  | { readonly kind: 'not_configured' }
  /**
   * Nothing answered. **Distinct from a rejection on purpose**: `api.telegram.org` is
   * not reachable from this operator's country, so a local run fails here with a
   * network error that looks exactly like a wrong token. Telling the two apart is the
   * difference between "set up a proxy" and "go and copy the token again".
   */
  | { readonly kind: 'unreachable'; readonly code: string }
  | {
      readonly kind: 'rejected';
      readonly category: TelegramRejection;
      readonly errorCode: number;
    };

export interface SendOutcome {
  readonly ok: boolean;
  /** The text exceeded the cap, so it went out truncated with the full text attached. */
  readonly truncated: boolean;
  readonly documentAttached: boolean;
  readonly failure: TransportFailure | null;
  /** Telegram's own `parameters.retry_after`, in seconds. Overrides any backoff. */
  readonly retryAfterSeconds: number | null;
}

export interface OutboundText {
  readonly text: string;
  /** `<kind>-<queue id>.txt`. Both halves are the panel's own values. */
  readonly documentName: string;
  /**
   * The marker appended when the text has to be cut, given the full character count.
   *
   * Supplied by the caller because it is human language and the caller knows the
   * locale; called by the transport because the 4096-character cap is Telegram's and
   * nobody else's business.
   */
  readonly truncationMarker: (characters: number) => string;
  /** Caption for the attached document. Human language, so again the caller's. */
  readonly documentCaption: string;
}

/**
 * What the queue worker talks to.
 *
 * One method, so a later SMTP or ntfy transport is an added file rather than a rewrite,
 * and so the worker cannot accidentally depend on anything Telegram-shaped.
 */
export interface NotificationTransport {
  send(message: OutboundText): Promise<SendOutcome>;
}

/** A single flat category, for `last_error` and for audit metadata. Never a body. */
export function failureCategory(failure: TransportFailure): string {
  switch (failure.kind) {
    case 'not_configured':
      return 'not_configured';
    case 'unreachable':
      return `unreachable:${failure.code}`;
    case 'rejected':
      return `rejected:${failure.category}`;
  }
}

/**
 * The sentences an operator reads, in English, for the CLI.
 *
 * Mapped from `error_code` plus a prefix match on `description` — **never by forwarding
 * Telegram's own text**, which echoes request parameters back, and one of the request
 * parameters is the chat id. M2.5's UI will render the same categories through the
 * client's dictionary; this copy exists because `npm run telegram:test` has no client
 * and no locale, which is the same exemption the notification renderer has.
 */
export const FAILURE_SENTENCES: Record<TelegramRejection | 'unreachable' | 'not_configured', string> =
  {
    not_configured:
      'No bot token and chat id are stored yet. Run `npm run telegram:set` first.',
    unreachable:
      'The panel could not reach Telegram at all — nothing answered. This is a network ' +
      'result, not a rejected credential: api.telegram.org is unreachable from some ' +
      'countries, and from a local container you will need PANEL_OUTBOUND_PROXY. It ' +
      'works from Railway.',
    bad_token:
      'Telegram does not recognise this bot token. Copy it again from @BotFather — a ' +
      'token stops working the moment you press /revoke.',
    unknown_chat:
      'Telegram has no chat with this id for this bot. Use `npm run telegram:discover` ' +
      'rather than typing an id.',
    not_started:
      'Open Telegram, find your bot, and press Start. A bot cannot message someone who ' +
      'has not messaged it first.',
    rate_limited:
      'Telegram is rate-limiting this bot. The queue will retry after the interval it ' +
      'asked for.',
    webhook_active:
      'This bot has a webhook set, and Telegram will not serve getUpdates while one is. ' +
      'Delete the webhook, or read the chat id from the webhook receiver instead.',
    other:
      'Telegram refused the request. The panel does not show its message, because ' +
      'Telegram errors can echo back what was sent.',
  };

export function sentenceFor(failure: TransportFailure): string {
  switch (failure.kind) {
    case 'not_configured':
      return FAILURE_SENTENCES.not_configured;
    case 'unreachable':
      return `${FAILURE_SENTENCES.unreachable} (${failure.code})`;
    case 'rejected':
      return FAILURE_SENTENCES[failure.category];
  }
}

/** A chat `getUpdates` has seen. Candidates Telegram just handed us, not stored values. */
export interface DiscoveredChat {
  readonly id: string;
  readonly type: string;
  readonly label: string | null;
}

export interface TelegramCredentials {
  readonly token: SecretString;
  readonly chatId: SecretString;
}

export interface TelegramTransportOptions {
  /** Read once per attempt, immediately before the request. Null when unconfigured. */
  credentials: () => TelegramCredentials | null;
  /**
   * Applied to every byte of every outbound body, immediately before it leaves.
   *
   * The event was already redacted at enqueue time; this is the second pass, at the
   * last possible moment, because this is the first door in the project that leads
   * outside the machine. Belt and braces, deliberately.
   */
  sanitise?: (text: string) => string;
  fetch?: OutboundFetch;
  proxyUrl?: string | undefined;
  baseUrl?: string;
  /** For the log line. Never receives a URL or a body. */
  log?: (event: { message: string; status?: number; category?: string }) => void;
}

interface TelegramErrorBody {
  ok?: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/**
 * Splits `text` for the wire: a message at or under the cap, and the full text when it
 * was over.
 *
 * **Counted in code points, not UTF-16 units.** `String.length` counts surrogate halves,
 * so a Persian or emoji-bearing summary that is 4096 by `length` can be well under the
 * limit Telegram counts, and — worse — a slice by `length` can cut a surrogate pair in
 * half and produce a lone surrogate that is not valid UTF-8.
 */
export function splitForWire(
  text: string,
  marker: (characters: number) => string,
): { message: string; full: string | null } {
  const points = Array.from(text);
  if (points.length <= TELEGRAM_TEXT_LIMIT) return { message: text, full: null };

  const markerText = marker(points.length);
  const budget = TELEGRAM_TEXT_LIMIT - (Array.from(markerText).length + 1);
  if (budget <= 0) {
    // A marker longer than the whole allowance. Nothing sensible to append; send what
    // fits and let the document carry the rest.
    return { message: points.slice(0, TELEGRAM_TEXT_LIMIT).join(''), full: text };
  }

  let cut = points.slice(0, budget).join('');
  // Prefer a line boundary if one is close, so the cut does not land mid-word.
  const lastNewline = cut.lastIndexOf('\n');
  if (lastNewline !== -1 && Array.from(cut.slice(lastNewline)).length <= NEWLINE_SEARCH_WINDOW) {
    cut = cut.slice(0, lastNewline);
  }

  return { message: `${cut}\n${markerText}`, full: text };
}

/** Builds a `multipart/form-data` body by hand. See `OutboundInit.body` for why. */
function multipart(fields: {
  chatId: string;
  caption: string;
  filename: string;
  contents: string;
}): { body: Buffer; contentType: string } {
  const boundary = `----panel${randomBytes(16).toString('hex')}`;
  const part = (name: string, value: string, extra = ''): string =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n${value}\r\n`;

  const head =
    part('chat_id', fields.chatId) +
    part('caption', fields.caption) +
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fields.filename}"\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n\r\n';

  return {
    body: Buffer.concat([
      Buffer.from(head, 'utf8'),
      Buffer.from(fields.contents, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** 401/400/403/429 → a category, from the code plus a prefix match on the description. */
export function categorise(errorCode: number, description: string): TelegramRejection {
  const text = description.toLowerCase();
  if (errorCode === 401) return 'bad_token';
  if (errorCode === 429) return 'rate_limited';
  if (errorCode === 409 && text.includes('webhook')) return 'webhook_active';
  if (errorCode === 400 && text.includes('chat not found')) return 'unknown_chat';
  if (
    errorCode === 403 &&
    (text.includes('blocked') ||
      text.includes("can't initiate conversation") ||
      text.includes('bot was kicked') ||
      text.includes('user is deactivated'))
  ) {
    return 'not_started';
  }
  return 'other';
}

const IDENTITY = (text: string): string => text;

export class TelegramTransport implements NotificationTransport {
  readonly #credentials: () => TelegramCredentials | null;
  readonly #sanitise: (text: string) => string;
  readonly #fetch: OutboundFetch;
  readonly #baseUrl: string;
  readonly #log: (event: { message: string; status?: number; category?: string }) => void;

  constructor(opts: TelegramTransportOptions) {
    this.#credentials = opts.credentials;
    this.#sanitise = opts.sanitise ?? IDENTITY;
    this.#fetch = opts.fetch ?? createOutboundFetch({ proxyUrl: opts.proxyUrl });
    this.#baseUrl = opts.baseUrl ?? TELEGRAM_API_ORIGIN;
    this.#log = opts.log ?? ((): void => {});
  }

  /**
   * Sends one message, and — when it was too long — the full text as a document after it.
   *
   * The two are separate requests and the second is allowed to fail on its own. If the
   * message is delivered and the document is not, the row is **sent**: the operator has
   * the readable part, and treating the pair as one atomic delivery would re-send the
   * truncated message on the next attempt.
   */
  async send(message: OutboundText): Promise<SendOutcome> {
    const credentials = this.#credentials();
    if (credentials === null) {
      return {
        ok: false,
        truncated: false,
        documentAttached: false,
        failure: { kind: 'not_configured' },
        retryAfterSeconds: null,
      };
    }

    const chatId = credentials.chatId.reveal();
    const clean = this.#sanitise(message.text);
    const { message: wire, full } = splitForWire(clean, message.truncationMarker);

    // PLAIN TEXT. `parse_mode` is deliberately not set, and this is not a limitation.
    // MarkdownV2 requires escaping eighteen characters, HTML mode requires escaping
    // three, and a single unescaped one makes Telegram answer
    // `400 Bad Request: can't parse entities` — rejecting the whole message. The payload
    // here is a Claude Code report: backticks, underscores, asterisks, brackets and
    // hyphens are what it is *made of*. Formatting is worth nothing next to delivery.
    // Do not "improve" this by adding a parse mode.
    const sent = await this.#post(credentials, 'sendMessage', {
      chat_id: chatId,
      text: wire,
      disable_web_page_preview: true,
    });
    if (!sent.ok) {
      return {
        ok: false,
        truncated: full !== null,
        documentAttached: false,
        failure: sent.failure,
        retryAfterSeconds: sent.retryAfterSeconds,
      };
    }

    if (full === null) {
      return {
        ok: true,
        truncated: false,
        documentAttached: false,
        failure: null,
        retryAfterSeconds: null,
      };
    }

    const document = multipart({
      chatId,
      caption: this.#sanitise(message.documentCaption),
      filename: message.documentName,
      contents: this.#sanitise(full),
    });
    const attached = await this.#request(credentials, 'sendDocument', {
      method: 'POST',
      headers: { 'content-type': document.contentType },
      body: document.body,
    });
    if (!attached.ok) {
      this.#log({
        message: 'telegram sendDocument failed; the message itself was delivered',
        category: failureCategory(attached.failure),
      });
    }

    return {
      ok: true,
      truncated: true,
      documentAttached: attached.ok,
      failure: null,
      retryAfterSeconds: null,
    };
  }

  /**
   * The chats this bot has received a message from.
   *
   * Discovery exists because a bot cannot message a chat that has never messaged it, and
   * the chat id is not something an operator can look up. `getUpdates` only returns
   * *recent* updates, so the instruction is "press Start, then run this".
   */
  async discoverChats(): Promise<
    { ok: true; chats: DiscoveredChat[] } | { ok: false; failure: TransportFailure }
  > {
    const credentials = this.#credentials();
    if (credentials === null) return { ok: false, failure: { kind: 'not_configured' } };

    const result = await this.#request(credentials, 'getUpdates?limit=100&timeout=0', {
      method: 'GET',
    });
    if (!result.ok) return { ok: false, failure: result.failure };

    const chats = new Map<string, DiscoveredChat>();
    const updates = (result.body as { result?: unknown }).result;
    for (const update of Array.isArray(updates) ? updates : []) {
      const record = update as Record<string, unknown>;
      for (const key of ['message', 'edited_message', 'channel_post', 'my_chat_member']) {
        const chat = (record[key] as { chat?: Record<string, unknown> } | undefined)?.chat;
        if (chat === undefined) continue;
        const id = String(chat.id ?? '');
        if (id === '') continue;
        const label =
          (chat.title as string | undefined) ??
          (chat.username as string | undefined) ??
          (chat.first_name as string | undefined) ??
          null;
        chats.set(id, { id, type: String(chat.type ?? 'unknown'), label });
      }
    }
    return { ok: true, chats: [...chats.values()] };
  }

  /** `getMe` — proves the token without sending anything to anyone. */
  async checkToken(): Promise<{ ok: true } | { ok: false; failure: TransportFailure }> {
    const credentials = this.#credentials();
    if (credentials === null) return { ok: false, failure: { kind: 'not_configured' } };
    const result = await this.#request(credentials, 'getMe', { method: 'GET' });
    return result.ok ? { ok: true } : { ok: false, failure: result.failure };
  }

  #post(
    credentials: TelegramCredentials,
    method: string,
    payload: Record<string, unknown>,
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; failure: TransportFailure; retryAfterSeconds: number | null }
  > {
    return this.#request(credentials, method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Sanitised as a whole serialised body, not field by field, so nothing can be
      // added to this payload later and quietly skip the pass.
      body: this.#sanitise(JSON.stringify(payload)),
    });
  }

  /**
   * One request. The URL is built here and **never logged**, because the bot token is a
   * path segment of it.
   */
  async #request(
    credentials: TelegramCredentials,
    method: string,
    init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string | Uint8Array },
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; failure: TransportFailure; retryAfterSeconds: number | null }
  > {
    const url = `${this.#baseUrl}/bot${credentials.token.reveal()}/${method}`;
    let status: number;
    let text: string;
    try {
      const response = await this.#fetch(url, init);
      status = response.status;
      text = await response.text();
    } catch (err) {
      const code = err instanceof OutboundUnreachableError ? err.code : 'UNKNOWN';
      this.#log({ message: `telegram ${method} could not be reached`, category: code });
      return { ok: false, failure: { kind: 'unreachable', code }, retryAfterSeconds: null };
    }

    let body: TelegramErrorBody = {};
    try {
      body = JSON.parse(text) as TelegramErrorBody;
    } catch {
      // A body that is not JSON at all — a proxy's error page, most likely.
    }

    if (status >= 200 && status < 300 && body.ok !== false) {
      this.#log({ message: `telegram ${method}`, status });
      return { ok: true, body };
    }

    const errorCode = body.error_code ?? status;
    const category = categorise(errorCode, body.description ?? '');
    const retryAfter = body.parameters?.retry_after;
    this.#log({ message: `telegram ${method} refused`, status, category });
    return {
      ok: false,
      failure: { kind: 'rejected', category, errorCode },
      // Telegram's own figure, and it is authoritative: it is not averaged with the
      // generic backoff and it is not ignored in favour of it.
      retryAfterSeconds: typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter : null,
    };
  }
}
