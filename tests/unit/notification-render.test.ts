import { describe, it, expect } from 'vitest';
import { DICTS, renderEvent } from '../../src/server/services/notification-render.js';
import type { NotifyEvent, NotifyLocale } from '../../src/server/services/notification-render.js';
import { NOTIFICATION_RULES } from '../../src/server/services/notification-rules.js';

const LOCALES: NotifyLocale[] = ['en', 'fa'];

const turn: NotifyEvent = {
  kind: 'turn_complete',
  projectId: '9f8e7d6c-0000-4000-8000-000000000001',
  projectName: 'acme-web',
  outcome: 'finished',
  durationMs: 252_000,
  backgroundTasks: 0,
  message: 'Added the retry wrapper around the upload call and a test for the 429 path.',
};

describe('renderEvent', () => {
  it('puts the project name first, because that is all a phone notification shows', () => {
    const { text } = renderEvent(turn, { locale: 'en' });
    const lines = text.split('\n');

    expect(lines[0]).toBe('acme-web — finished');
    expect(lines[1]).toBe('4m 12s');
    expect(lines[2]).toBe('');
    expect(lines[3]).toContain('Added the retry wrapper');
  });

  it('names the background tasks in the outcome rather than a separate line', () => {
    const { text } = renderEvent(
      { ...turn, outcome: 'finished_with_background', backgroundTasks: 2 },
      { locale: 'en' },
    );
    expect(text.split('\n')[0]).toBe('acme-web — finished, 2 background tasks still running');
  });

  it('omits the link by default and appends it only when one is given', () => {
    // The default is the decision: the link contains the base path, and a Telegram message
    // is permanent storage the panel does not control.
    expect(renderEvent(turn, { locale: 'en' }).text).not.toContain('http');
    expect(renderEvent(turn, { locale: 'en', link: null }).text).not.toContain('http');

    const linked = renderEvent(turn, {
      locale: 'en',
      link: 'https://panel.example.com/base/projects/9f8e',
    });
    expect(linked.text.endsWith('https://panel.example.com/base/projects/9f8e')).toBe(true);
  });

  it('renders every kind in both languages, with no untranslated fragment left', () => {
    const events: NotifyEvent[] = [
      turn,
      { kind: 'test', at: '2026-01-01T00:00:00.000Z' },
      {
        kind: 'resource_alert',
        resource: 'memory',
        state: 'above',
        percent: 87,
        thresholdPercent: 85,
        usedBytes: 934_281_216,
        limitBytes: 1_073_741_824,
        aboveForSeconds: null,
      },
      {
        kind: 'resource_alert',
        resource: 'disk',
        state: 'cleared',
        percent: 68.5,
        thresholdPercent: 80,
        usedBytes: 934_281_216,
        limitBytes: null,
        aboveForSeconds: 754,
      },
      { kind: 'oom_kill', newKills: 2, totalKills: 5, usedBytes: 640_000_000, limitBytes: 1_073_741_824 },
      {
        kind: 'unclean_restart',
        previousStartedAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T02:12:30.000Z',
        ranForSeconds: 7950,
        usedBytes: 1_020_000_000,
        limitBytes: 1_073_741_824,
      },
      {
        kind: 'security_alert',
        event: 'login.failure',
        outcome: 'failure',
        at: '2026-01-01T00:00:00.000Z',
        suppressed: 14,
        windowMinutes: 15,
        reason: 'bad_credentials',
      },
    ];

    for (const locale of LOCALES) {
      for (const event of events) {
        const rendered = renderEvent(event, { locale });
        expect(rendered.text.length, `${locale}/${event.kind}`).toBeGreaterThan(0);
        expect(rendered.documentName).toBe(`${event.kind}.txt`);
      }
    }

    // The Persian strings are actually Persian, rather than the English ones copied
    // across: the same failure mode the client's dictionary test is specified to catch.
    const security = events.find((e) => e.kind === 'security_alert')!;
    const en = renderEvent(security, { locale: 'en' }).text;
    const fa = renderEvent(security, { locale: 'fa' }).text;
    expect(fa).not.toBe(en);
    expect(fa).toMatch(/[؀-ۿ]/);
    // The machine values stay Latin in both, deliberately: they are the values that would
    // reorder in a bidirectional line, and Telegram has no isolation island to put them in.
    expect(fa).toContain('14');
    expect(fa).toContain('bad_credentials');
  });

  it('has a headline in both languages for exactly the events that notify', () => {
    const notified = Object.entries(NOTIFICATION_RULES)
      .filter(([, rule]) => rule !== null)
      .map(([event]) => event);

    for (const locale of LOCALES) {
      expect(Object.keys(DICTS[locale].headline).sort()).toEqual([...notified].sort());
      for (const [event, headline] of Object.entries(DICTS[locale].headline)) {
        expect(headline.length, `${locale}/${event}`).toBeGreaterThan(0);
      }
    }
  });

  it('formats a duration and a byte count, which is the one exception it is allowed', () => {
    // The server does not translate — except here, because a Telegram message has no
    // client to do it. Everything else about these numbers stays machine-readable.
    expect(DICTS.en.duration(0)).toBe('0s');
    expect(DICTS.en.duration(59_400)).toBe('59s');
    expect(DICTS.en.duration(3_723_000)).toBe('1h 2m 3s');
    expect(DICTS.en.bytes(0)).toBe('0 B');
    expect(DICTS.en.bytes(1024)).toBe('1 KB');
    expect(DICTS.en.bytes(1_073_741_824)).toBe('1 GB');
    expect(DICTS.fa.duration(252_000)).toBe('4د و 12ث');
  });
});
