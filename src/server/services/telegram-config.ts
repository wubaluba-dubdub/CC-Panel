import type { SecretsRepository } from './secrets.service.js';
import type { TelegramCredentials } from './telegram.transport.js';

/**
 * Where the Telegram credentials live, and the one way to read them.
 *
 * The scope and the two names are fixed here rather than spelled at each call site,
 * because they are half of the AAD: a payload is bound to `secrets:telegram:bot_token`,
 * so a typo in the name is not a missing secret, it is a `DecryptionError` on a row that
 * is perfectly good.
 *
 * The chat id is treated as a credential and not as a setting, which is worth stating
 * because it does not look like one. It is the only thing standing between an attacker
 * who has the token and a delivery address, and it is a stable identifier for the
 * operator's Telegram account. It belongs in the same box as the token.
 */
export const TELEGRAM_SCOPE = 'telegram';
export const BOT_TOKEN = 'bot_token';
export const CHAT_ID = 'chat_id';

export interface SecretPresence {
  readonly set: boolean;
  /** Characters, when set. Catches a truncated paste; reveals nothing else. */
  readonly length: number | null;
}

export interface TelegramConfigStatus {
  readonly configured: boolean;
  readonly botToken: SecretPresence;
  readonly chatId: SecretPresence;
}

/**
 * Reads both credentials, or null when either is missing.
 *
 * Called immediately before a request and never assigned to anything that outlives it.
 * The token goes into the URL path — which is where Telegram puts it — so the URL is a
 * secret too, and this is the only place that produces the material for one.
 */
export function readTelegramCredentials(secrets: SecretsRepository): TelegramCredentials | null {
  const token = secrets.get(TELEGRAM_SCOPE, BOT_TOKEN);
  const chatId = secrets.get(TELEGRAM_SCOPE, CHAT_ID);
  if (token === null || chatId === null) return null;
  return { token, chatId };
}

/**
 * Set-or-not-set and a length, for the status endpoint and the CLI.
 *
 * Decrypts in order to count characters, which is the whole reason the count is the most
 * that is ever reported: there is no way to know the length without holding the value,
 * and there is no reason to report anything more than the length. Never `mask()` — see
 * `routes/notifications.ts`.
 */
export function telegramConfigStatus(secrets: SecretsRepository): TelegramConfigStatus {
  const describe = (name: string): SecretPresence => {
    const value = secrets.get(TELEGRAM_SCOPE, name);
    return value === null ? { set: false, length: null } : { set: true, length: value.reveal().length };
  };
  const botToken = describe(BOT_TOKEN);
  const chatId = describe(CHAT_ID);
  return { configured: botToken.set && chatId.set, botToken, chatId };
}
