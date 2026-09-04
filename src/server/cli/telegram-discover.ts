import { sentenceFor } from '../services/telegram.transport.js';
import { Report } from './report.js';
import { isMain, openPanel } from './telegram-cli.js';

/**
 * `npm run telegram:discover` — the chats this bot has heard from.
 *
 * This command exists because of one asymmetry that catches every beginner: **a bot
 * cannot message a chat that has never messaged it**, and a chat id is not something an
 * operator can look up anywhere. So the sequence is: press Start in Telegram, run this,
 * pick the id, store it with `telegram:set`.
 *
 * This is the one place chat ids are displayed, and it is the exception that proves the
 * rule: these are candidates Telegram has just handed us, not the stored credential read
 * back out.
 *
 * Two Telegram behaviours it handles rather than discovers:
 *
 * - `getUpdates` returns only **recent** updates, so an empty list usually means "press
 *   Start and run it again" rather than "there are no chats";
 * - if a webhook is ever set on this bot, `getUpdates` answers `409 Conflict` and no
 *   amount of retrying will help. That gets its own sentence instead of being reported as
 *   "no chats found".
 */
async function main(): Promise<number> {
  const report = new Report();
  const panel = openPanel();

  try {
    report.section('Chats this bot can message');
    const result = await panel.transport.discoverChats();

    if (!result.ok) {
      report.fail('getUpdates', sentenceFor(result.failure));
      return report.finish();
    }

    if (result.chats.length === 0) {
      report.warn(
        'no chats yet',
        'getUpdates only returns recent updates. Open Telegram, send your bot any message — press Start if you have not — and run this again.',
      );
      return report.finish();
    }

    for (const chat of result.chats) {
      report.pass(chat.id, `${chat.type}${chat.label === null ? '' : ` — ${chat.label}`}`);
    }
    report.info(
      'next',
      'run telegram:set --chat-id and paste the id you want. A negative id is a group or channel.',
    );
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

export { main as runTelegramDiscover };
