import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SecretString } from '../../src/server/crypto.js';
import { createBasePathElider, redactSecrets } from '../../src/server/plugins/logger-redaction.js';
import {
  TELEGRAM_TEXT_LIMIT,
  TelegramTransport,
  categorise,
  failureCategory,
  splitForWire,
} from '../../src/server/services/telegram.transport.js';
import { startFakeTelegram, type FakeTelegram } from '../helpers/fake-telegram.js';

const TOKEN = '123456789:AAtest-token-that-is-long-enough-xx';
const CHAT = '987654321';
const MARKER = (characters: number): string => `— truncated, full text attached (${characters} characters)`;

let fake: FakeTelegram;

function transportFor(fakeServer: FakeTelegram, sanitise?: (text: string) => string): TelegramTransport {
  return new TelegramTransport({
    credentials: () => ({ token: new SecretString(TOKEN), chatId: new SecretString(CHAT) }),
    baseUrl: fakeServer.baseUrl,
    ...(sanitise ? { sanitise } : {}),
  });
}

function message(text: string): {
  text: string;
  documentName: string;
  truncationMarker: (characters: number) => string;
  documentCaption: string;
} {
  return {
    text,
    documentName: 'test-1.txt',
    truncationMarker: MARKER,
    documentCaption: 'The full text of the message above.',
  };
}

beforeEach(async () => {
  fake = await startFakeTelegram();
});

afterEach(async () => {
  await fake.close();
});

describe('splitForWire', () => {
  it('leaves anything at or under the cap alone', () => {
    const text = 'x'.repeat(TELEGRAM_TEXT_LIMIT);
    expect(splitForWire(text, MARKER)).toEqual({ message: text, full: null });
  });

  it('counts code points, not UTF-16 units', () => {
    // 3000 astral characters are 6000 UTF-16 units and 3000 characters to Telegram. A
    // limit checked with `String.length` would truncate this needlessly — and a *slice*
    // by `length` could cut a surrogate pair in half and put a lone surrogate on the wire.
    const emoji = '🔐'.repeat(3000);
    expect(emoji.length).toBe(6000);
    expect(splitForWire(emoji, MARKER).full).toBeNull();

    const tooLong = '🔐'.repeat(TELEGRAM_TEXT_LIMIT + 1);
    const split = splitForWire(tooLong, MARKER);
    expect(split.full).toBe(tooLong);
    expect(Array.from(split.message).length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    // No lone surrogate survived the cut.
    expect(split.message).toBe(Buffer.from(split.message, 'utf8').toString('utf8'));
  });

  it('cuts at a nearby newline and appends the marker with the full length', () => {
    const body = `${'a'.repeat(TELEGRAM_TEXT_LIMIT - 100)}\n${'b'.repeat(200)}`;
    const split = splitForWire(body, MARKER);

    expect(Array.from(split.message).length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(split.message.endsWith(MARKER(Array.from(body).length))).toBe(true);
    // The cut landed on the line boundary rather than mid-run.
    expect(split.message.split('\n').at(-2)).toBe('a'.repeat(TELEGRAM_TEXT_LIMIT - 100));
    expect(split.full).toBe(body);
  });
});

describe('categorise', () => {
  it('maps the three failures a beginner actually hits', () => {
    expect(categorise(401, 'Unauthorized')).toBe('bad_token');
    expect(categorise(400, 'Bad Request: chat not found')).toBe('unknown_chat');
    expect(categorise(403, 'Forbidden: bot was blocked by the user')).toBe('not_started');
    expect(categorise(403, "Forbidden: bot can't initiate conversation with a user")).toBe(
      'not_started',
    );
    expect(categorise(429, 'Too Many Requests: retry later')).toBe('rate_limited');
    expect(categorise(409, 'Conflict: can\'t use getUpdates method while webhook is active')).toBe(
      'webhook_active',
    );
    // Anything else is `other` rather than a guess, and the operator is told the code
    // without being shown Telegram's text — which echoes request parameters back.
    expect(categorise(400, 'Bad Request: message is too long')).toBe('other');
    expect(categorise(500, 'Internal Server Error')).toBe('other');
  });
});

describe('TelegramTransport', () => {
  it('sends plain text with no parse_mode', async () => {
    const outcome = await transportFor(fake).send(message('hello'));

    expect(outcome.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request.method).toBe('POST');
    // The token is a path segment, which is why the URL itself is a secret.
    expect(request.path).toBe(`/bot${TOKEN}/sendMessage`);
    expect(request.json).toEqual({
      chat_id: CHAT,
      text: 'hello',
      disable_web_page_preview: true,
    });
    // The assertion this file exists for: MarkdownV2 needs eighteen characters escaped
    // and a Claude Code report is made of them, so one unescaped backtick would turn the
    // whole message into `400 can't parse entities`. Plain text is the correct choice.
    expect(request.body).not.toContain('parse_mode');
  });

  it('truncates and then attaches the full text as a document', async () => {
    const long = `${'a'.repeat(TELEGRAM_TEXT_LIMIT)}bcd`;
    const outcome = await transportFor(fake).send(message(long));

    expect(outcome).toMatchObject({ ok: true, truncated: true, documentAttached: true });
    expect(fake.requests).toHaveLength(2);

    const [sent, document] = fake.requests as [(typeof fake.requests)[0], (typeof fake.requests)[0]];
    expect(sent.path).toContain('/sendMessage');
    expect(Array.from(String(sent.json!.text)).length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(String(sent.json!.text)).toContain('truncated, full text attached');

    expect(document.path).toContain('/sendDocument');
    expect(String(document.headers['content-type'])).toContain('multipart/form-data; boundary=');
    expect(document.body).toContain('filename="test-1.txt"');
    expect(document.body).toContain('Content-Type: text/plain; charset=utf-8');
    // The whole text, not the truncated one.
    expect(document.body).toContain(long);
  });

  it('counts the message as sent when only the document fails', async () => {
    fake.reply({ status: 200, body: { ok: true, result: {} } });
    fake.reply({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request' } });

    const outcome = await transportFor(fake).send(message('a'.repeat(TELEGRAM_TEXT_LIMIT + 10)));

    // The operator has the readable part. Treating the pair as one atomic delivery would
    // re-send the truncated message on the next attempt, forever.
    expect(outcome).toMatchObject({ ok: true, truncated: true, documentAttached: false });
  });

  it('honours parameters.retry_after on a 429', async () => {
    fake.reply({
      status: 429,
      body: {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 42',
        parameters: { retry_after: 42 },
      },
    });

    const outcome = await transportFor(fake).send(message('hello'));

    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toEqual({ kind: 'rejected', category: 'rate_limited', errorCode: 429 });
    // Telegram's own figure, to be used instead of the generic backoff and not averaged
    // with it: it is the authority on when it will accept the next request.
    expect(outcome.retryAfterSeconds).toBe(42);
  });

  it('reports "nothing answered" differently from "answered and refused"', async () => {
    const closed = new TelegramTransport({
      credentials: () => ({ token: new SecretString(TOKEN), chatId: new SecretString(CHAT) }),
      // A port nothing is listening on: the shape of api.telegram.org from a country
      // that cannot reach it, which otherwise looks exactly like a wrong token.
      baseUrl: 'http://127.0.0.1:1',
    });

    const outcome = await closed.send(message('hello'));
    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.kind).toBe('unreachable');
    expect(failureCategory(outcome.failure!)).toMatch(/^unreachable:/);
  });

  it('says not_configured rather than sending nowhere', async () => {
    const unconfigured = new TelegramTransport({
      credentials: () => null,
      baseUrl: fake.baseUrl,
    });

    const outcome = await unconfigured.send(message('hello'));
    expect(outcome.failure).toEqual({ kind: 'not_configured' });
    expect(fake.requests).toHaveLength(0);
  });

  it('scrubs the outbound body, message and attachment alike', async () => {
    const sentinel = `sk-ant-api03-${randomBytes(12).toString('hex')}`;
    const basePath = 'egress-base-path-sentinel';
    const elide = createBasePathElider(basePath);
    const sanitise = (text: string): string => elide(redactSecrets(text));

    const long = `${'a'.repeat(TELEGRAM_TEXT_LIMIT)} ${sentinel} /${basePath}/projects/7`;
    await transportFor(fake, sanitise).send(message(long));

    // Both requests, in the bytes that actually left. This is the first door in the
    // project that leads outside the machine.
    for (const request of fake.requests) {
      expect(request.body, request.path).not.toContain(sentinel);
      expect(request.body, request.path).not.toContain(basePath);
    }
    expect(fake.requests.at(-1)!.body).toContain('[redacted]');
  });

  it('lists the chats getUpdates has seen, and explains a webhook conflict', async () => {
    fake.reply({
      status: 200,
      body: {
        ok: true,
        result: [
          { message: { chat: { id: 111, type: 'private', first_name: 'Operator' } } },
          { message: { chat: { id: -222, type: 'supergroup', title: 'Ops' } } },
          { message: { chat: { id: 111, type: 'private', first_name: 'Operator' } } },
        ],
      },
    });

    const discovered = await transportFor(fake).discoverChats();
    expect(discovered.ok).toBe(true);
    expect(discovered.ok && discovered.chats).toEqual([
      { id: '111', type: 'private', label: 'Operator' },
      { id: '-222', type: 'supergroup', label: 'Ops' },
    ]);

    fake.reply({
      status: 409,
      body: {
        ok: false,
        error_code: 409,
        description: "Conflict: can't use getUpdates method while webhook is active",
      },
    });
    const conflicted = await transportFor(fake).discoverChats();
    expect(conflicted.ok).toBe(false);
    expect(!conflicted.ok && conflicted.failure).toEqual({
      kind: 'rejected',
      category: 'webhook_active',
      errorCode: 409,
    });
  });
});
