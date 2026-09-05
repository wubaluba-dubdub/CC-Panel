/**
 * A user-agent string, reduced to three facts.
 *
 * The sessions list used to render the raw string. On the operator's own screen that was six
 * monospaced lines — the tallest object on the page — saying `Mozilla/5.0 (Windows NT 10.0;
 * Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`, of which
 * the useful part is *Chrome 152 on Windows*. The raw string is still reachable, behind the row
 * expander, because when the question is "is that session mine?" the exact bytes are the answer.
 *
 * ── This value is attacker-influenced, and the function is written for that ───
 *
 * `User-Agent` is a request header. Anything that can reach the login endpoint can put 4 KB of
 * anything in it, including right-to-left controls, angle brackets and a `<script>` tag, and the
 * panel then stores it and shows it back. Three properties follow, and each is a test:
 *
 * 1. **The input is capped before anything else touches it.** 256 characters; a real user agent
 *    is under 200 and a 4 KB one is not a browser.
 * 2. **The output comes from a closed set.** Two enumerations plus a major version of at most
 *    four digits. No substring of the input is ever returned, so no bidi control, no bracket and
 *    no tag can reach the page through this path — which is a stronger statement than "React
 *    escapes it".
 * 3. **It guesses nothing beyond those three facts.** No engine, no minor version, no device.
 *    Anything unrecognised is `Unknown`, which the screen renders as a translated word.
 *
 * ── No dependency, and that is standing rule 4 rather than pride ─────────────
 *
 * A user-agent parsing library tracks other people's browser releases, so its release cadence is
 * set by Google and Apple, and it would sit inside the container that holds `PANEL_MASTER_KEY`.
 * What it would buy is device names and engine versions the panel does not show. The three facts
 * it does show are three substring checks each.
 */

/** The longest input considered. A real user agent is under 200 characters. */
export const UA_CAP = 256;

export const BROWSERS = [
  'Chrome',
  'Edge',
  'Firefox',
  'Safari',
  'Opera',
  'Chromium',
  'curl',
  'Unknown',
] as const;

export const PLATFORMS = [
  'Windows',
  'macOS',
  'Linux',
  'Android',
  'iOS',
  'ChromeOS',
  'Unknown',
] as const;

export type BrowserName = (typeof BROWSERS)[number];
export type PlatformName = (typeof PLATFORMS)[number];

export interface ClientSummary {
  browser: BrowserName;
  /** The major version, digits only, or null when the token carried none. */
  version: string | null;
  platform: PlatformName;
}

/**
 * The order is the whole algorithm, because every one of these strings lies about the others.
 *
 * Chrome's user agent claims Safari, Edge's claims Chrome *and* Safari, Opera's claims all three.
 * So the most specific claim is tested first and the version is read from **the token that
 * matched**, not from the first version-looking number in the string.
 */
const BROWSER_TOKENS: readonly { browser: BrowserName; token: string }[] = [
  { browser: 'curl', token: 'curl' },
  { browser: 'Edge', token: 'Edg' },
  { browser: 'Opera', token: 'OPR' },
  { browser: 'Firefox', token: 'Firefox' },
  { browser: 'Chromium', token: 'Chromium' },
  { browser: 'Chrome', token: 'Chrome' },
  { browser: 'Safari', token: 'Version' },
];

/**
 * Android carries `Linux` and iOS carries `Mac OS X`, so these are also ordered from the most
 * specific claim to the least.
 */
const PLATFORM_TOKENS: readonly { platform: PlatformName; pattern: RegExp }[] = [
  { platform: 'ChromeOS', pattern: /\bCrOS\b/ },
  { platform: 'Android', pattern: /\bAndroid\b/ },
  { platform: 'iOS', pattern: /\b(?:iPhone|iPad|iPod)\b/ },
  { platform: 'Windows', pattern: /\bWindows\b/ },
  { platform: 'macOS', pattern: /\b(?:Macintosh|Mac OS X)\b/ },
  { platform: 'Linux', pattern: /\b(?:Linux|X11|FreeBSD)\b/ },
];

export function summariseClient(raw: string | null | undefined): ClientSummary {
  if (raw === null || raw === undefined) return { browser: 'Unknown', version: null, platform: 'Unknown' };
  // Capped first, so nothing below ever runs a regex over an unbounded string.
  const ua = [...raw].slice(0, UA_CAP).join('');

  let browser: BrowserName = 'Unknown';
  let version: string | null = null;
  for (const candidate of BROWSER_TOKENS) {
    if (!ua.includes(candidate.token)) continue;
    // Safari's own version lives in `Version/17.4`, and it is only Safari if nothing above
    // matched — which is what the loop order already guarantees.
    if (candidate.browser === 'Safari' && !ua.includes('Safari')) continue;
    browser = candidate.browser;
    version = new RegExp(`${candidate.token}/(\\d{1,4})`).exec(ua)?.[1] ?? null;
    break;
  }
  // A bare `Safari/605.1.15` with no `Version/` token: still Safari, and the version is the
  // WebKit build rather than the browser's, so it is deliberately not reported.
  if (browser === 'Unknown' && ua.includes('Safari')) browser = 'Safari';

  let platform: PlatformName = 'Unknown';
  for (const candidate of PLATFORM_TOKENS) {
    if (candidate.pattern.test(ua)) {
      platform = candidate.platform;
      break;
    }
  }

  return { browser, version, platform };
}

/**
 * The browser half of the summary as one string: a proper noun and a number.
 *
 * Not a sentence. The connecting word ("on") comes from the dictionaries and the two names do
 * not — a browser is called Chrome in Persian too, and building a translated sentence *around*
 * attacker-influenced input is how a translation ends up carrying something it did not write.
 * `Unknown` is the one member that is a word rather than a name, so the caller translates it.
 */
export function browserLabel(summary: ClientSummary): string | null {
  if (summary.browser === 'Unknown') return null;
  return summary.version === null ? summary.browser : `${summary.browser} ${summary.version}`;
}
