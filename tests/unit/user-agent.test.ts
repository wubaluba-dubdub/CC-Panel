import { describe, it, expect } from 'vitest';
import {
  BROWSERS,
  PLATFORMS,
  UA_CAP,
  browserLabel,
  summariseClient,
} from '../../src/client/lib/user-agent.js';

/**
 * The client summariser, against real strings and against hostile ones.
 *
 * `User-Agent` is a request header, so anything that can reach the login endpoint can put anything
 * in it, and the panel stores it and shows it back. The property that matters is not "does it
 * recognise Chrome" — it is that **no substring of the input can reach the screen through this
 * function**: the output is two members of closed enumerations plus at most four digits. That is a
 * stronger statement than "React escapes it", and it is what makes the summary safe to put in a
 * sentence.
 */

const REAL: { name: string; ua: string; browser: string; version: string | null; platform: string }[] = [
  {
    name: 'Chrome on Windows — the operator’s own',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    browser: 'Chrome',
    version: '152',
    platform: 'Windows',
  },
  {
    name: 'Edge claims Chrome and Safari as well',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.2649.54',
    browser: 'Edge',
    version: '151',
    platform: 'Windows',
  },
  {
    name: 'Firefox on Linux',
    ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0',
    browser: 'Firefox',
    version: '134',
    platform: 'Linux',
  },
  {
    name: 'Safari on macOS carries its version in Version/',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15',
    browser: 'Safari',
    version: '18',
    platform: 'macOS',
  },
  {
    name: 'Safari on iOS is iOS and not macOS',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    browser: 'Safari',
    version: '18',
    platform: 'iOS',
  },
  {
    name: 'Chrome on Android is Android and not Linux',
    ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
    browser: 'Chrome',
    version: '152',
    platform: 'Android',
  },
  {
    name: 'Opera claims Chrome and Safari',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 OPR/135.0.0.0',
    browser: 'Opera',
    version: '135',
    platform: 'Windows',
  },
  {
    name: 'a ChromeOS device',
    ua: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    browser: 'Chrome',
    version: '152',
    platform: 'ChromeOS',
  },
  {
    name: 'curl, which is how the API is exercised',
    ua: 'curl/8.5.0',
    browser: 'curl',
    version: '8',
    platform: 'Unknown',
  },
];

describe('the client summariser reads three facts', () => {
  for (const one of REAL) {
    it(one.name, () => {
      const summary = summariseClient(one.ua);
      expect(summary.browser).toBe(one.browser);
      expect(summary.version).toBe(one.version);
      expect(summary.platform).toBe(one.platform);
    });
  }

  it('renders the browser as a proper noun and a number, and never a sentence', () => {
    expect(browserLabel(summariseClient(REAL[0]!.ua))).toBe('Chrome 152');
    // The one member that is a word rather than a name is left to the caller to translate.
    expect(browserLabel({ browser: 'Unknown', version: null, platform: 'Unknown' })).toBeNull();
    expect(browserLabel({ browser: 'Safari', version: null, platform: 'macOS' })).toBe('Safari');
  });
});

describe('the client summariser is safe on hostile input', () => {
  const HOSTILE: { name: string; ua: string }[] = [
    { name: 'the empty string', ua: '' },
    { name: 'whitespace only', ua: '   \t\n  ' },
    { name: '4 KB of one character', ua: 'A'.repeat(4096) },
    { name: '4 KB that also claims to be Chrome', ua: `${'A'.repeat(4000)} Chrome/152.0.0.0` },
    { name: 'right-to-left controls', ua: 'Mozilla/5.0 ‮evil‬ مرورگر Chrome/152.0' },
    { name: 'angle brackets and a script tag', ua: '<script>alert(1)</script> Chrome/152.0 (Windows NT 10.0)' },
    { name: 'three browsers at once', ua: 'Mozilla/5.0 Firefox/1 Chrome/2 Safari/3 Edg/4' },
    { name: 'a version that is not a number', ua: 'Chrome/notaversion (Windows NT 10.0)' },
    { name: 'a version of forty digits', ua: `Chrome/${'9'.repeat(40)} (Windows NT 10.0)` },
    { name: 'a quote and a closing brace', ua: 'Chrome/152" }); (Windows NT 10.0)' },
  ];

  for (const one of HOSTILE) {
    it(`returns closed-set members for ${one.name}`, () => {
      const summary = summariseClient(one.ua);
      expect(BROWSERS).toContain(summary.browser);
      expect(PLATFORMS).toContain(summary.platform);
      // At most four digits, and digits only: this is the one field derived from the input, and
      // it is the only place a caller could be surprised.
      if (summary.version !== null) expect(summary.version).toMatch(/^\d{1,4}$/);
      // Nothing the input carried comes out. The label is a name, a space and digits.
      const label = browserLabel(summary);
      if (label !== null) expect(label).toMatch(/^[A-Za-z]+(?: \d{1,4})?$/);
    });
  }

  it('returns Unknown for a missing header rather than throwing', () => {
    for (const missing of [null, undefined]) {
      expect(summariseClient(missing)).toEqual({
        browser: 'Unknown',
        version: null,
        platform: 'Unknown',
      });
    }
  });

  it('caps the input before it runs a single pattern over it', () => {
    // A browser token past the cap is not found, which is the point: the cap is not a hint.
    const beyond = `${'A'.repeat(UA_CAP)}Chrome/152.0`;
    expect(summariseClient(beyond).browser).toBe('Unknown');
    const within = `${'A'.repeat(UA_CAP - 20)} Chrome/152.0`;
    expect(summariseClient(within).browser).toBe('Chrome');
  });

  it('is deterministic on a string that lies', () => {
    // There is no right answer for `Firefox/1 Chrome/2 Safari/3 Edg/4`; there is a *stable* one,
    // and the version comes from the token that matched rather than from the first number.
    const summary = summariseClient('Mozilla/5.0 Firefox/1 Chrome/2 Safari/3 Edg/4');
    expect(summary.browser).toBe('Edge');
    expect(summary.version).toBe('4');
  });
});
