import { sentenceFor } from '../services/telegram.transport.js';
import { telegramConfigStatus } from '../services/telegram-config.js';
import { Report } from './report.js';
import { isMain, openPanel } from './telegram-cli.js';

/**
 * `npm run telegram:test` — enqueue a real test message, deliver it, and say which stage
 * succeeded.
 *
 * The stages matter more than the verdict, because they need completely different fixes:
 *
 * 1. **credentials stored** — `telegram:set` has been run;
 * 2. **Telegram reachable** — something answered at all. From this operator's country
 *    nothing will, and that is a *network* result rather than a rejected credential;
 * 3. **token accepted** (`getMe`) — the token is live and has not been `/revoke`d;
 * 4. **queued** — the row is in `notification_queue`, which is where it would sit
 *    forever if delivery were broken;
 * 5. **delivered** — Telegram accepted the message for that chat.
 *
 * Collapsing 2 and 3 is the mistake this command exists to avoid: "could not reach
 * Telegram" and "Telegram says your token is wrong" look identical from a failed `curl`
 * and mean opposite things.
 */
async function main(): Promise<number> {
  const report = new Report();
  const panel = openPanel();

  try {
    report.section('Telegram delivery test');

    const config = telegramConfigStatus(panel.secrets);
    if (!config.configured) {
      report.fail(
        'credentials stored',
        `bot token ${config.botToken.set ? 'set' : 'not set'}, chat id ${config.chatId.set ? 'set' : 'not set'} — run telegram:set`,
      );
      return report.finish();
    }
    report.pass('credentials stored', 'both values present and decrypt cleanly');

    // getMe proves the token without sending anything to anybody, and separates
    // "unreachable" from "refused" before a message is ever queued.
    const token = await panel.transport.checkToken();
    if (!token.ok) {
      if (token.failure.kind === 'unreachable') {
        report.fail('Telegram reachable', sentenceFor(token.failure));
      } else {
        report.pass('Telegram reachable', 'it answered');
        report.fail('token accepted', sentenceFor(token.failure));
      }
      return report.finish();
    }
    report.pass('Telegram reachable', 'it answered');
    report.pass('token accepted', 'getMe succeeded — the bot exists and the token is live');

    const queued = panel.notify.notify({ kind: 'test', at: new Date().toISOString() });
    if (queued.queued === null) {
      report.fail('queued', `the queue refused the event (${queued.reason})`);
      return report.finish();
    }
    report.pass('queued', `notification_queue row ${queued.queued}`);

    // One turn of the same worker the server runs. Not a special send path: if this
    // works and the server's does not, the difference is the worker, and there is only
    // one of those.
    const attempt = await panel.notify.tick();
    if (attempt === null) {
      report.fail('delivered', 'the worker found nothing due, which should be impossible here');
      return report.finish();
    }
    if (attempt.state === 'sent') {
      report.pass('delivered', 'look at your phone');
      return report.finish();
    }

    report.fail(
      'delivered',
      `${attempt.category ?? 'unknown'} — the row is ${attempt.state} and will be retried`,
    );
    const row = panel.notify.row(attempt.id);
    if (row !== null) {
      report.info('next attempt', row.nextAttemptAt);
    }
    // The categories map to sentences; the raw Telegram description is deliberately not
    // shown anywhere, because those echo back what was sent.
    if (attempt.category?.startsWith('rejected:') === true) {
      const category = attempt.category.slice('rejected:'.length);
      report.info(
        'what to do',
        sentenceFor({
          kind: 'rejected',
          category: category as 'bad_token',
          errorCode: 0,
        }),
      );
    }
    return report.finish();
  } finally {
    panel.close();
  }
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}

export { main as runTelegramTest };
