import { AuditEvent } from '../services/audit.service.js';
import { BOT_TOKEN, CHAT_ID, TELEGRAM_SCOPE, telegramConfigStatus } from '../services/telegram-config.js';
import { Report, describeSecret } from './report.js';
import { hasFlag, isMain, openPanel, promptSecret } from './telegram-cli.js';

/**
 * `npm run telegram:set` — store or rotate the bot token and the chat id.
 *
 * Both are stored exactly as `PUT /api/secrets` stores them: through
 * `SecretsRepository`, encrypted under an HKDF subkey with the payload bound to
 * `secrets:telegram:<name>`, with a `secret.changed` audit row that records the scope and
 * the name and never the value. This command is a second front door to the same code, not
 * a second storage path — a second path would be a second thing to audit and the sentinel
 * sweep would have to learn about it.
 *
 * With no flags it offers both values and an empty answer skips one, so rotating just the
 * token is the default gesture. `--token` and `--chat-id` narrow it, which is also what
 * makes the piped form unambiguous.
 */

/** Telegram's own shape: `<bot id>:<secret>`. Refused early, with a reason. */
function validateToken(value: string): string | null {
  if (!value.includes(':')) {
    return 'That does not look like a bot token — BotFather gives you `<digits>:<letters>`. Copy the whole line.';
  }
  const [id, secret] = value.split(':', 2) as [string, string];
  if (!/^\d{5,}$/.test(id)) return 'The part before the colon should be the numeric bot id.';
  if (secret.length < 20) {
    return 'The part after the colon is too short — the paste was probably truncated.';
  }
  return null;
}

/**
 * A numeric chat id, positive for a person and negative for a group or channel.
 *
 * `@channelname` is accepted by Telegram's API and is deliberately **not** accepted here:
 * a username is public, and this value is stored and treated as a credential. Storing a
 * public identifier in the credential box teaches the wrong lesson about the box.
 */
function validateChatId(value: string): string | null {
  return /^-?\d{1,20}$/.test(value)
    ? null
    : 'A chat id is digits, with a leading minus for a group or channel. Run `telegram:discover` to find yours.';
}

async function main(): Promise<number> {
  const report = new Report();
  const panel = openPanel();
  const wantToken = hasFlag('token') || !hasFlag('chat-id');
  const wantChatId = hasFlag('chat-id') || !hasFlag('token');

  try {
    report.section('Telegram credentials (values are never printed)');
    const before = telegramConfigStatus(panel.secrets);
    report.info('bot token', describeSecret(before.botToken.set ? 'x'.repeat(before.botToken.length ?? 0) : undefined));
    report.info('chat id', describeSecret(before.chatId.set ? 'x'.repeat(before.chatId.length ?? 0) : undefined));

    const writes: { name: string; value: string }[] = [];

    if (wantToken) {
      const token = await promptSecret('Bot token (paste, then Enter; empty to skip)');
      if (token.length > 0) {
        const problem = validateToken(token);
        if (problem !== null) {
          report.fail('bot token accepted', problem);
          return report.finish();
        }
        writes.push({ name: BOT_TOKEN, value: token });
      } else {
        report.info('bot token', 'left unchanged');
      }
    }

    if (wantChatId) {
      const chatId = await promptSecret('Chat id (empty to skip)');
      if (chatId.length > 0) {
        const problem = validateChatId(chatId);
        if (problem !== null) {
          report.fail('chat id accepted', problem);
          return report.finish();
        }
        writes.push({ name: CHAT_ID, value: chatId });
      } else {
        report.info('chat id', 'left unchanged');
      }
    }

    for (const write of writes) {
      const replaced = panel.secrets.has(TELEGRAM_SCOPE, write.name);
      panel.secrets.set(TELEGRAM_SCOPE, write.name, write.value);
      panel.audit.write({
        event: AuditEvent.SecretChanged,
        outcome: 'success',
        // The same metadata the HTTP route writes: scope and name, never the value and
        // never a masked form of it. `actorIp` is null — this is a shell, not a request.
        meta: { scope: TELEGRAM_SCOPE, name: write.name, replaced, via: 'cli' },
      });
      report.pass(`${write.name} stored`, `${write.value.length} characters, encrypted at rest`);
    }

    const after = telegramConfigStatus(panel.secrets);
    if (after.configured) {
      report.pass('configuration complete', 'run `telegram:test` to send a real message');
    } else {
      report.warn(
        'configuration incomplete',
        `${after.botToken.set ? 'chat id' : 'bot token'} is still missing — nothing will be delivered until both are set`,
      );
    }
    return report.finish();
  } finally {
    panel.close();
  }
}

if (isMain(import.meta.url)) {
  process.stdout.write('Telegram credentials. Values are read from a prompt, never from the command line.\n');
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}

export { main as runTelegramSet, validateChatId, validateToken };
