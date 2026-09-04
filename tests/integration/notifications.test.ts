import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  SESSION_COOKIE,
  createAuthTestServer,
  enrollAccount,
  postLogin,
  stepUp,
  type AuthTestContext,
} from '../helpers/auth-harness.js';
import { startFakeTelegram, type FakeTelegram } from '../helpers/fake-telegram.js';
import { getDb } from '../../src/server/db.js';
import { mask } from '../../src/server/crypto.js';
import { AuditEvent } from '../../src/server/services/audit.service.js';
import type { NotificationStatusResponse } from '../../src/shared/types.js';

const BASE = 'notiftest-base-path-sentinel';
const TOKEN = `123456789:AA${randomBytes(16).toString('hex')}`;
const CHAT = '987654321';
/** Patterned, so the failure mode is a leak rather than an unlucky fixture. */
const SENTINEL = `sk-ant-api03-${randomBytes(12).toString('hex')}`;

let ctx: AuthTestContext;
let fake: FakeTelegram;

afterEach(async () => {
  if (ctx) await ctx.cleanup();
  if (fake) await fake.close();
});

async function serverWithFakeTelegram(): Promise<AuthTestContext> {
  fake = await startFakeTelegram();
  return createAuthTestServer(
    { PANEL_BASE_PATH: BASE },
    { notify: { telegramBaseUrl: fake.baseUrl } },
  );
}

/** Stores both credentials the way the operator's CLI and the M2.5 UI both will. */
function storeCredentials(context: AuthTestContext): void {
  context.app.auth.secrets.set('telegram', 'bot_token', TOKEN);
  context.app.auth.secrets.set('telegram', 'chat_id', CHAT);
}

function auditMeta(event: string): Record<string, unknown> | null {
  const row = getDb()
    .prepare('SELECT meta_json FROM audit_log WHERE event = ? ORDER BY id DESC LIMIT 1')
    .get(event) as { meta_json: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.meta_json) as Record<string, unknown>);
}

describe('GET /api/notifications/telegram', () => {
  it('reports set-or-unset and a length, and never the value or its mask', async () => {
    ctx = await serverWithFakeTelegram();
    const account = await enrollAccount(ctx);
    storeCredentials(ctx);

    const res = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/notifications/telegram'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    expect(res.statusCode, res.body).toBe(200);

    const body = res.json() as NotificationStatusResponse;
    expect(body.configured).toBe(true);
    expect(body.botToken).toEqual({ set: true, length: TOKEN.length });
    expect(body.chatId).toEqual({ set: true, length: CHAT.length });
    expect(body.includeLinks).toBe(false);
    // Enrolment itself produced alerts — `setup.completed` and `login.success` are two of
    // the events `notification-rules.ts` says are worth waking someone for, and this
    // account was just created. The queue is the mechanism working, not test noise.
    expect(body.queue.pending).toBeGreaterThan(0);
    expect(Object.keys(body.queue).sort()).toEqual(['abandoned', 'pending', 'sending', 'sent']);

    // Not even the masked form. `mask()` keeps the last four characters, which is
    // harmless for a 46-character bot token and is not harmless for a nine-digit chat
    // id — four digits of a stable identifier for the operator's Telegram account, in a
    // response that can be read again and again.
    expect(res.body).not.toContain(TOKEN);
    expect(res.body).not.toContain(CHAT);
    expect(res.body).not.toContain(mask(TOKEN));
    expect(res.body).not.toContain(CHAT.slice(-4));
  });

  it('needs a full session', async () => {
    ctx = await serverWithFakeTelegram();
    await enrollAccount(ctx);

    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: ctx.url('/api/notifications/telegram'),
    });
    expect(anonymous.statusCode).toBe(401);

    const login = await postLogin(ctx);
    const pre = ctx.cookieFrom(login)!;
    const preSession = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/notifications/telegram'),
      cookies: { [SESSION_COOKIE]: pre },
    });
    expect(preSession.statusCode).toBe(401);
  });
});

describe('the credentials are written through PUT /api/secrets', () => {
  it('is step-up gated there, and needs no endpoint of its own', async () => {
    ctx = await serverWithFakeTelegram();
    const account = await enrollAccount(ctx);

    // A full session is not enough for a secret write, and the Telegram pair is not an
    // exception. There is deliberately no second endpoint that writes them: a second
    // path would be a second thing to gate correctly.
    const withoutStepUp = await ctx.inject({
      method: 'PUT',
      url: ctx.url('/api/secrets'),
      cookies: { [SESSION_COOKIE]: account.cookie },
      payload: { scope: 'telegram', name: 'bot_token', value: TOKEN },
    });
    expect(withoutStepUp.statusCode).toBe(403);

    expect((await stepUp(ctx, account.cookie, account.secret)).statusCode).toBe(200);
    for (const [name, value] of [
      ['bot_token', TOKEN],
      ['chat_id', CHAT],
    ] as const) {
      const written = await ctx.inject({
        method: 'PUT',
        url: ctx.url('/api/secrets'),
        cookies: { [SESSION_COOKIE]: account.cookie },
        payload: { scope: 'telegram', name, value },
      });
      expect(written.statusCode, written.body).toBe(204);
    }

    const status = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/notifications/telegram'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    expect((status.json() as NotificationStatusResponse).configured).toBe(true);

    // The audit row is the one `PUT /api/secrets` already writes: scope and name, never
    // the value.
    expect(auditMeta(AuditEvent.SecretChanged)).toMatchObject({
      scope: 'telegram',
      name: 'chat_id',
    });
    expect(JSON.stringify(auditMeta(AuditEvent.SecretChanged))).not.toContain(CHAT);
  });
});

describe('POST /api/notifications/test', () => {
  it('answers 202 with a queue row and does not wait for delivery', async () => {
    ctx = await serverWithFakeTelegram();
    const account = await enrollAccount(ctx);
    storeCredentials(ctx);

    const res = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/notifications/test'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });

    // 202, deliberately: a synchronous send would make this endpoint's response time a
    // function of a third party's availability, which is the one thing the queue exists
    // to prevent. Nothing has been sent yet.
    expect(res.statusCode, res.body).toBe(202);
    const { queued } = res.json() as { queued: number };
    expect(queued).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(0);

    const row = await ctx.inject({
      method: 'GET',
      url: ctx.url(`/api/notifications/queue/${queued}`),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    expect(row.json()).toMatchObject({ id: queued, kind: 'test', state: 'pending', attempts: 0 });

    // And it is not step-up gated: it discloses nothing, and requiring a fresh code to
    // check whether notifications work would push the operator toward not checking.
    const unknown = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/notifications/queue/99999'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('egress — the sentinel sweep, extended to the wire', () => {
  it('sends a real request whose bytes contain neither the sentinel nor the base path', async () => {
    ctx = await serverWithFakeTelegram();
    await enrollAccount(ctx);
    storeCredentials(ctx);

    // Enrolment queued its own security alerts. Drain them and start from a clean wire,
    // so the assertions below are about the one event this test plants.
    await ctx.app.notify.drain();
    fake.requests.length = 0;

    // A turn report of the shape Phase 3 will produce, carrying both sentinels through
    // the whole path: enqueue → row → render → transport → socket.
    ctx.app.notify.notify({
      kind: 'turn_complete',
      projectId: '9f8e7d6c-0000-4000-8000-000000000001',
      projectName: 'acme-web',
      outcome: 'finished',
      durationMs: 252_000,
      backgroundTasks: 0,
      message: `wrote ${SENTINEL} into /${BASE}/api/secrets and it worked`,
    });

    const attempt = await ctx.app.notify.tick();
    expect(attempt).toMatchObject({ state: 'sent' });

    // The request really happened, and the token really is in its path — which is why
    // the URL is a secret and why the transport never logs one.
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request.path).toBe(`/bot${TOKEN}/sendMessage`);
    expect(String(request.json!.text)).toContain('acme-web — finished');

    // The assertion this test exists for: the bytes that left the process.
    expect(request.body, 'the sentinel reached the wire').not.toContain(SENTINEL);
    expect(request.body, 'the base path reached the wire').not.toContain(BASE);
    expect(request.body).toContain('[redacted]');
    expect(request.body).toContain('<base>');

    // And the row on the volume is clean too — redaction happens at enqueue, not at send,
    // because this table persists and a log line does not.
    const stored = (
      getDb()
        .prepare("SELECT event_json FROM notification_queue WHERE kind = 'turn_complete'")
        .get() as { event_json: string }
    ).event_json;
    expect(stored).not.toContain(SENTINEL);
    expect(stored).not.toContain(BASE);

    // The audit log records the outcome and not the message.
    const meta = auditMeta(AuditEvent.NotificationSent);
    void meta;
    expect(meta).toMatchObject({ kind: 'turn_complete', attempts: 1 });
    expect(JSON.stringify(meta)).not.toContain('acme-web');
    expect(JSON.stringify(meta)).not.toContain(SENTINEL);
    expect(ctx.app.auth.audit.verify().ok).toBe(true);
  });

  it('omits the deep link unless PANEL_NOTIFY_INCLUDE_LINKS is on', async () => {
    fake = await startFakeTelegram();
    ctx = await createAuthTestServer(
      { PANEL_BASE_PATH: BASE, PANEL_NOTIFY_INCLUDE_LINKS: true },
      { notify: { telegramBaseUrl: fake.baseUrl } },
    );
    await enrollAccount(ctx);
    storeCredentials(ctx);
    await ctx.app.notify.drain();
    fake.requests.length = 0;

    ctx.app.notify.notify({
      kind: 'turn_complete',
      projectId: 'abc',
      projectName: 'acme-web',
      outcome: 'finished',
      durationMs: 1000,
      backgroundTasks: 0,
      message: null,
    });
    await ctx.app.notify.tick();

    // With the setting on, the link — and therefore the base path — is on the wire. That
    // is the documented consequence of the setting and not a leak: anyone who can read
    // that chat can reach the login page, which is what the setting's description says.
    //
    // It is also why the egress elision is conditional on this setting rather than
    // absolute: eliding the prefix here would produce `/<base>/projects/abc`, a URL that
    // 404s — the setting switched on and silently broken. See `app.ts`.
    const text = String(fake.requests[0]!.json!.text);
    expect(text).toContain('/projects/abc');
    expect(text).toContain(BASE);

    // The stored row still does not carry it. The link is composed at render time from
    // configuration, so the queue table on the volume never holds the prefix.
    const stored = (
      getDb()
        .prepare("SELECT event_json FROM notification_queue WHERE kind = 'turn_complete'")
        .get() as { event_json: string }
    ).event_json;
    expect(stored).not.toContain(BASE);
  });
});

/** Strips block and line comments, so only executable text is scanned. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('the transport is the only file that knows where Telegram is', () => {
  it('is the only file under src/ that names api.telegram.org', () => {
    // Same mechanism as `cookie-discipline.test.ts`, and the same reasoning: the URL
    // carries the bot token in its path, so every place that builds one is a place that
    // can log one.
    const root = join(import.meta.dirname, '..', '..', 'src');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (entry.name === 'telegram.transport.ts') continue;
        // Code only. Prose *about* the policy is the point of the policy — the same rule
        // the other static scans in this suite use, or a comment explaining why the URL is
        // a secret would fail the assertion that it is not spelled anywhere.
        if (codeOnly(readFileSync(path, 'utf-8')).includes('api.telegram.org')) {
          offenders.push(path);
        }
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});
