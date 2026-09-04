import type { AuditOutcome } from './audit.service.js';
import type { NotifiedAuditEvent } from './notification-rules.js';

/**
 * Typed event → the text one transport will send.
 *
 * **This is the one place in the server that holds human language, and it is the one
 * place that has a reason to.** R3's rule is that the server does not translate:
 * `GET /api/audit`, `GET /api/metrics` and every error body are machine-readable and
 * the client owns every string. A Telegram message has no client. So the queued event
 * carries a `locale` and this module renders it — including the two formatting jobs
 * that are otherwise forbidden server-side, a duration and a byte count, because
 * `4m 12s` cannot be composed by a recipient that is a chat window.
 *
 * The dictionary is a typed interface with two implementations rather than a lookup
 * with string keys, so a missing or misspelled key is a compile error. `headline` is
 * keyed on {@link NotifiedAuditEvent} — exactly the events `notification-rules.ts` says
 * produce a message — so an event that starts notifying cannot ship without a sentence
 * in both languages, and an event that stops notifying cannot leave a dead one behind.
 */

export type NotifyLocale = 'en' | 'fa';

/** Derived from the Phase 3 Stop payload, never from parsing the terminal. */
export type TurnOutcome = 'finished' | 'finished_with_background' | 'stopped_early' | 'failed';

/**
 * What `notify()` accepts.
 *
 * A typed event, never a rendered string. Three consequences the implementation is
 * built around: a transport decides its own formatting (Telegram's 4096-character cap
 * and its truncate-then-attach behaviour are properties of Telegram, not of "a
 * notification"); the queue row stores the event, so nothing rendered is ever
 * persisted; and every producer — the Phase 3 turn hook, the resource watcher, the
 * audit-derived security alerts — reaches the same queue without the transport knowing
 * which one it was.
 */
export type NotifyEvent =
  | {
      readonly kind: 'turn_complete';
      /**
       * The project's UUID, not a row id: M2.0 fixed that projects carry one, and it is
       * what a deep link is built from.
       */
      readonly projectId: string;
      /** Not a secret — the operator chose it, and a message that will not say which
       * project it is about is not worth sending. Always first in the message. */
      readonly projectName: string;
      readonly outcome: TurnOutcome;
      readonly durationMs: number;
      readonly message: string | null;
      readonly backgroundTasks: number;
    }
  | {
      readonly kind: 'resource_alert';
      readonly resource: 'memory' | 'cpu' | 'disk';
      /**
       * A crossing, or the return from one.
       *
       * Both directions are the same event with a flag, because they carry the same
       * numbers about the same rule — and because a recovery that did not look like
       * the alert it answers is harder to read on a phone, not easier.
       */
      readonly state: 'above' | 'cleared';
      /**
       * 0–100, one decimal place.
       *
       * A percentage in a *notification* is not the percentage M1.7 removed from
       * `GET /api/metrics`. That one was removed because the client formats and the
       * server has no locale; this module is the sanctioned exception to that rule,
       * for the one recipient that is a chat window and cannot divide.
       */
      readonly percent: number;
      /** The threshold it crossed, so the message says what "high" meant. */
      readonly thresholdPercent: number;
      readonly usedBytes: number | null;
      readonly limitBytes: number | null;
      /** How long it was above. Set on `cleared`, null on `above`. */
      readonly aboveForSeconds: number | null;
    }
  | {
      readonly kind: 'oom_kill';
      /** Processes killed since the last message. The kernel counts processes, not events. */
      readonly newKills: number;
      /** The cgroup's cumulative counter, for context. */
      readonly totalKills: number;
      readonly usedBytes: number | null;
      readonly limitBytes: number | null;
    }
  | {
      readonly kind: 'unclean_restart';
      /** From the previous run's marker. Null when the marker could not be parsed. */
      readonly previousStartedAt: string | null;
      readonly lastSeenAt: string | null;
      readonly ranForSeconds: number | null;
      /** The previous run's last recorded memory reading — the OOM clue. */
      readonly usedBytes: number | null;
      readonly limitBytes: number | null;
    }
  | {
      readonly kind: 'security_alert';
      readonly event: NotifiedAuditEvent;
      readonly outcome: AuditOutcome;
      /** ISO-8601, from the audit row this was derived from. */
      readonly at: string;
      /** How many further events the throttle window swallowed. Zero is normal. */
      readonly suppressed: number;
      readonly windowMinutes: number;
      /** A failure *category* from the audit row. Never an attempted credential. */
      readonly reason: string | null;
    }
  | { readonly kind: 'test'; readonly at: string };

export type NotifyEventKind = NotifyEvent['kind'];

export interface RenderedMessage {
  /** The whole message, plain text. No Markdown, ever — see the transport. */
  readonly text: string;
  /** Filename to use if the text has to go out as a document instead. */
  readonly documentName: string;
}

interface Dict {
  testTitle: string;
  testBody: string;
  securityTitle: string;
  resourceTitle: string;
  headline: Record<NotifiedAuditEvent, string>;
  outcome: Record<TurnOutcome, string>;
  resource: Record<'memory' | 'cpu' | 'disk', string>;
  resourceAbove(resource: string, percent: number): string;
  resourceCleared(resource: string, percent: number): string;
  aboveThreshold(percent: number): string;
  aboveFor(duration: string): string;
  oomTitle: string;
  oomKilled(newKills: number, total: number): string;
  oomChildOnly: string;
  uncleanTitle: string;
  uncleanWindow(startedAt: string, lastSeenAt: string): string;
  uncleanRanFor(duration: string): string;
  uncleanLastReading(reading: string): string;
  uncleanNoMarkerDetail: string;
  uncleanCause: string;
  /** `4m 12s`. The units are words, so they are in here and not in a shared helper. */
  duration(ms: number): string;
  bytes(value: number): string;
  backgroundTasks(count: number): string;
  suppressed(count: number, windowMinutes: number): string;
  failureReason(category: string): string;
  outcomeFailed: string;
  ofLimit(used: string, limit: string): string;
  usedOnly(used: string): string;
  atTime(iso: string): string;
  truncatedMarker(characters: number): string;
  documentCaption(): string;
}

const en: Dict = {
  testTitle: 'Claude Code panel — test message',
  testBody: 'If you are reading this, notifications are working.',
  securityTitle: 'Panel security',
  resourceTitle: 'Panel resources',
  headline: {
    'login.success': 'someone signed in',
    'setup.completed': 'first-time setup was completed',
    'password.changed': 'the password was changed',
    'two_factor.disabled': 'two-factor authentication was turned off',
    'recovery_codes.regenerated': 'the recovery codes were replaced',
    'base_path.regenerated': 'the secret URL was regenerated',
    'login.failure': 'a sign-in attempt failed',
    'totp.failure': 'a two-factor code was rejected',
    'recovery_code.used': 'a recovery code was used to sign in',
    'stepup.granted': 'a privileged action was authorised',
    'secret.revealed': 'a stored credential was read',
    'secret.changed': 'a stored credential was written',
    'audit.trimmed': 'the audit log reached its row limit and the oldest rows were removed',
  },
  outcome: {
    finished: 'finished',
    finished_with_background: 'finished',
    stopped_early: 'stopped early',
    failed: 'failed',
  },
  resource: { memory: 'memory', cpu: 'CPU', disk: 'disk' },
  resourceAbove: (resource, percent) => `${resource} is at ${percent}%`,
  resourceCleared: (resource, percent) => `${resource} is back to normal, ${percent}%`,
  aboveThreshold: (percent) => `the alert threshold is ${percent}%`,
  aboveFor: (duration) => `it was above the threshold for ${duration}`,
  oomTitle: 'Claude Code panel — something was killed for memory',
  oomKilled: (newKills, total) =>
    `${newKills === 1 ? '1 process' : `${newKills} processes`} killed just now, ${total} in total for this container`,
  oomChildOnly:
    'The panel is still running, so what was killed was one of its child processes — an agent, a build, or a command it ran — and not the panel itself.',
  uncleanTitle: 'Claude Code panel — the previous run did not shut down cleanly',
  uncleanWindow: (startedAt, lastSeenAt) => `it started at ${startedAt} and was last seen at ${lastSeenAt}`,
  uncleanRanFor: (duration) => `it had been running for ${duration}`,
  uncleanLastReading: (reading) => `its last memory reading was ${reading}`,
  uncleanNoMarkerDetail: 'nothing else about it could be read',
  uncleanCause:
    'The cause cannot be known from inside the panel: a container killed for memory, a platform restart that ran out of time, and a crash all look the same from here.',
  duration: (ms) => formatDuration(ms, { h: 'h', m: 'm', s: 's', joiner: ' ' }),
  bytes: (value) => formatBytes(value, ['B', 'KB', 'MB', 'GB', 'TB']),
  backgroundTasks: (count) =>
    count === 1 ? '1 background task still running' : `${count} background tasks still running`,
  suppressed: (count, windowMinutes) =>
    count === 1
      ? `1 further event of this kind in the last ${windowMinutes} minutes`
      : `${count} further events of this kind in the last ${windowMinutes} minutes`,
  failureReason: (category) => `reason: ${category}`,
  outcomeFailed: 'the attempt failed',
  ofLimit: (used, limit) => `${used} of ${limit}`,
  usedOnly: (used) => `${used} used, no limit set`,
  atTime: (iso) => `at ${iso}`,
  truncatedMarker: (characters) => `— truncated, full text attached (${characters} characters)`,
  documentCaption: () => 'The full text of the message above.',
};

/**
 * Persian. Written to be read on a phone in one glance, like the English.
 *
 * Latin digits deliberately, in both languages: these are machine values — a duration,
 * a byte count, a count of failures — and the panel's own rule for Phase 2 is that
 * machine values live in left-to-right islands. Telegram has no such islands, so the
 * digits are the plainest thing available. The dates are ISO-8601 for the same reason.
 */
const fa: Dict = {
  testTitle: 'پنل Claude Code — پیام آزمایشی',
  testBody: 'اگر این پیام را می‌بینید، اعلان‌ها درست کار می‌کنند.',
  securityTitle: 'امنیت پنل',
  resourceTitle: 'منابع پنل',
  headline: {
    'login.success': 'کسی وارد شد',
    'setup.completed': 'راه‌اندازی اولیه کامل شد',
    'password.changed': 'گذرواژه تغییر کرد',
    'two_factor.disabled': 'ورود دومرحله‌ای خاموش شد',
    'recovery_codes.regenerated': 'کدهای بازیابی جایگزین شدند',
    'base_path.regenerated': 'نشانی مخفی پنل از نو ساخته شد',
    'login.failure': 'یک تلاش ناموفق برای ورود',
    'totp.failure': 'کد دومرحله‌ای پذیرفته نشد',
    'recovery_code.used': 'برای ورود از یک کد بازیابی استفاده شد',
    'stepup.granted': 'یک عملیات حساس تأیید شد',
    'secret.revealed': 'یک اعتبارنامهٔ ذخیره‌شده خوانده شد',
    'secret.changed': 'یک اعتبارنامهٔ ذخیره‌شده نوشته شد',
    'audit.trimmed': 'گزارش رسیدگی به سقف خود رسید و قدیمی‌ترین ردیف‌ها پاک شدند',
  },
  outcome: {
    finished: 'به پایان رسید',
    finished_with_background: 'به پایان رسید',
    stopped_early: 'پیش از پایان متوقف شد',
    failed: 'شکست خورد',
  },
  resource: { memory: 'حافظه', cpu: 'پردازنده', disk: 'فضای دیسک' },
  resourceAbove: (resource, percent) => `${resource} روی ${percent}% است`,
  resourceCleared: (resource, percent) => `${resource} به حالت عادی برگشت، ${percent}%`,
  aboveThreshold: (percent) => `آستانهٔ هشدار ${percent}% است`,
  aboveFor: (duration) => `به مدت ${duration} بالاتر از آستانه بود`,
  oomTitle: 'پنل Claude Code — چیزی به دلیل کمبود حافظه کشته شد',
  oomKilled: (newKills, total) =>
    `${newKills} فرایند همین حالا کشته شد، در کل ${total} فرایند در این کانتینر`,
  oomChildOnly:
    'خود پنل هنوز در حال اجراست، پس آنچه کشته شد یکی از فرایندهای فرزند آن بوده است — یک عامل، یک ساخت، یا فرمانی که اجرا کرده — و نه خود پنل.',
  uncleanTitle: 'پنل Claude Code — اجرای قبلی به‌درستی خاتمه نیافت',
  uncleanWindow: (startedAt, lastSeenAt) => `شروع در ${startedAt} و آخرین نشانه از آن در ${lastSeenAt}`,
  uncleanRanFor: (duration) => `به مدت ${duration} در حال اجرا بود`,
  uncleanLastReading: (reading) => `آخرین اندازه‌گیری حافظهٔ آن ${reading} بود`,
  uncleanNoMarkerDetail: 'چیز دیگری از آن قابل خواندن نبود',
  uncleanCause:
    'علت را از داخل پنل نمی‌توان دانست: کشته‌شدن کانتینر به دلیل حافظه، راه‌اندازی مجددی که فرصت کافی نداشت، و خرابی برنامه از این‌جا یکسان به نظر می‌رسند.',
  duration: (ms) => formatDuration(ms, { h: 'س', m: 'د', s: 'ث', joiner: ' و ' }),
  bytes: (value) => formatBytes(value, ['B', 'KB', 'MB', 'GB', 'TB']),
  backgroundTasks: (count) => `${count} کار پس‌زمینه هنوز در حال اجراست`,
  suppressed: (count, windowMinutes) =>
    `${count} رویداد دیگر از همین نوع در ${windowMinutes} دقیقهٔ گذشته`,
  failureReason: (category) => `دلیل: ${category}`,
  outcomeFailed: 'تلاش ناموفق بود',
  ofLimit: (used, limit) => `${used} از ${limit}`,
  usedOnly: (used) => `${used} در حال استفاده، بدون سقف`,
  atTime: (iso) => `زمان: ${iso}`,
  truncatedMarker: (characters) => `— بریده شد، متن کامل پیوست است (${characters} نویسه)`,
  documentCaption: () => 'متن کامل پیام بالا.',
};

export const DICTS: Record<NotifyLocale, Dict> = { en, fa };

function formatDuration(
  ms: number,
  units: { h: string; m: string; s: string; joiner: string },
): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}${units.h}`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}${units.m}`);
  parts.push(`${seconds}${units.s}`);
  return parts.join(units.joiner);
}

function formatBytes(value: number, units: readonly string[]): string {
  let scaled = Math.max(0, value);
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  const rounded = index === 0 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${rounded} ${units[index]}`;
}

export interface RenderOptions {
  readonly locale: NotifyLocale;
  /**
   * A deep link into the panel, or null.
   *
   * Null is the default and the whole decision: the link contains the base path, and a
   * Telegram message is permanent storage the panel does not control. Whoever builds
   * this option has already read that argument — see `PANEL_NOTIFY_INCLUDE_LINKS`.
   */
  readonly link?: string | null;
}

/** Renders one event. Composition only: every value is already redacted and elided. */
export function renderEvent(event: NotifyEvent, opts: RenderOptions): RenderedMessage {
  const dict = DICTS[opts.locale];
  const lines: string[] = [];

  switch (event.kind) {
    case 'test':
      lines.push(dict.testTitle, dict.atTime(event.at), '', dict.testBody);
      break;

    case 'turn_complete': {
      // The project name comes first, because the first line is all a phone
      // notification shows. There is no unattributed shape.
      const outcome =
        event.outcome === 'finished_with_background'
          ? `${dict.outcome.finished_with_background}, ${dict.backgroundTasks(event.backgroundTasks)}`
          : dict.outcome[event.outcome];
      lines.push(`${event.projectName} — ${outcome}`, dict.duration(event.durationMs));
      if (event.message !== null && event.message.length > 0) lines.push('', event.message);
      break;
    }

    case 'resource_alert': {
      const resource = dict.resource[event.resource];
      lines.push(
        `${dict.resourceTitle} — ${
          event.state === 'above'
            ? dict.resourceAbove(resource, event.percent)
            : dict.resourceCleared(resource, event.percent)
        }`,
      );
      if (event.usedBytes !== null) {
        lines.push(
          event.limitBytes === null
            ? dict.usedOnly(dict.bytes(event.usedBytes))
            : dict.ofLimit(dict.bytes(event.usedBytes), dict.bytes(event.limitBytes)),
        );
      }
      lines.push(
        event.state === 'above'
          ? dict.aboveThreshold(event.thresholdPercent)
          : event.aboveForSeconds === null
            ? dict.aboveThreshold(event.thresholdPercent)
            : dict.aboveFor(dict.duration(event.aboveForSeconds * 1000)),
      );
      break;
    }

    case 'oom_kill': {
      lines.push(dict.oomTitle, dict.oomKilled(event.newKills, event.totalKills));
      if (event.usedBytes !== null) {
        lines.push(
          event.limitBytes === null
            ? dict.usedOnly(dict.bytes(event.usedBytes))
            : dict.ofLimit(dict.bytes(event.usedBytes), dict.bytes(event.limitBytes)),
        );
      }
      // The one sentence that stops this alert being read as "the panel died", which
      // it cannot be: a kill that takes the panel is reported by the *next* boot as an
      // unclean restart, because the process that died cannot send anything.
      lines.push('', dict.oomChildOnly);
      break;
    }

    case 'unclean_restart': {
      lines.push(dict.uncleanTitle);
      if (event.previousStartedAt !== null && event.lastSeenAt !== null) {
        lines.push(dict.uncleanWindow(event.previousStartedAt, event.lastSeenAt));
      } else {
        lines.push(dict.uncleanNoMarkerDetail);
      }
      if (event.ranForSeconds !== null) {
        lines.push(dict.uncleanRanFor(dict.duration(event.ranForSeconds * 1000)));
      }
      if (event.usedBytes !== null) {
        lines.push(
          dict.uncleanLastReading(
            event.limitBytes === null
              ? dict.bytes(event.usedBytes)
              : dict.ofLimit(dict.bytes(event.usedBytes), dict.bytes(event.limitBytes)),
          ),
        );
      }
      // "did not shut down cleanly" and never "crashed". A normal platform redeploy
      // that overran its grace period is a SIGKILL too, and from in here it is the
      // same evidence as an OOM kill: the marker was left behind.
      lines.push('', dict.uncleanCause);
      break;
    }

    case 'security_alert': {
      lines.push(`${dict.securityTitle} — ${dict.headline[event.event]}`, dict.atTime(event.at));
      if (event.outcome === 'failure') lines.push(dict.outcomeFailed);
      if (event.reason !== null) lines.push(dict.failureReason(event.reason));
      if (event.suppressed > 0) {
        lines.push(dict.suppressed(event.suppressed, event.windowMinutes));
      }
      break;
    }
  }

  if (opts.link !== undefined && opts.link !== null && opts.link.length > 0) {
    lines.push('', opts.link);
  }

  return { text: lines.join('\n'), documentName: `${event.kind}.txt` };
}

/** The audit event a security alert was derived from, for the queue row's `kind`. */
export function eventKindOf(event: NotifyEvent): NotifyEventKind {
  return event.kind;
}

/** Every string field of an event, so the enqueue path can scrub them in one pass. */
export function mapEventStrings(
  event: NotifyEvent,
  transform: (value: string) => string,
): NotifyEvent {
  switch (event.kind) {
    case 'turn_complete':
      return {
        ...event,
        projectName: transform(event.projectName),
        message: event.message === null ? null : transform(event.message),
      };
    case 'security_alert':
      return { ...event, reason: event.reason === null ? null : transform(event.reason) };
    case 'resource_alert':
    case 'oom_kill':
    case 'unclean_restart':
    case 'test':
      return event;
  }
}

/** Guard for a row read back out of the queue, which is JSON from the database. */
export function isNotifyEvent(value: unknown): value is NotifyEvent {
  if (value === null || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === 'turn_complete' ||
    kind === 'resource_alert' ||
    kind === 'security_alert' ||
    kind === 'oom_kill' ||
    kind === 'unclean_restart' ||
    kind === 'test'
  );
}
