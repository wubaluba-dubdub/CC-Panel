import type { Locale } from '../../shared/types.js';

/**
 * The first locale guess, from `Accept-Language`.
 *
 * ── Why the server guesses at all ───────────────────────────────────────────
 *
 * The interface is translated client-side (R3) and the server has no locale — with one
 * sanctioned exception, the notification transport, which has no client. This is not a
 * second exception: nothing here is *translated*, and the answer is a two-letter code that
 * `bootstrap.js` puts on the window so `documentElement.dir` is right **before first
 * paint**. A client that decided this for itself could only do so after its bundle had
 * parsed, which is one frame of left-to-right on a Persian page — and that frame is exactly
 * the artefact the whole direction design exists to avoid.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 *
 * It does not read the database and it does not look at a session. `bootstrap.js` is
 * unauthenticated, and `routes/api.ts` keeps reads off unauthenticated routes on purpose.
 * The operator's *stored* choice reaches the client through `GET /api/auth/me`, is cached in
 * `localStorage`, and is applied by the same bootstrap script on the next load — where it
 * outranks this guess.
 */

/** The two locales the panel has dictionaries for. Declared in the shared contract. */
export type PanelLocale = Locale;

/**
 * Picks a locale from an `Accept-Language` header.
 *
 * A deliberately small parser, because the input is attacker-controllable and the output is
 * one of two constants. It reads quality values, sorts by them, and returns `'fa'` only if a
 * Persian tag outranks every English one — so `en;q=0.9, fa;q=0.8` is English and
 * `fa-IR, en;q=0.8` is Persian. Anything unparseable, absent, or naming neither language is
 * `'en'`, which is the dictionary the source of truth is written in.
 *
 * `fa`, `fa-IR`, `fa-AF` and `prs` (Dari, which is Persian in a different orthography) all
 * count as Persian; `pes` is the ISO-639-3 code for Iranian Persian and is accepted for
 * completeness. No other tag maps onto either dictionary, and guessing from a script subtag
 * would be inventing a mapping the panel cannot honour.
 */
export function localeFromAcceptLanguage(header: unknown): PanelLocale {
  if (typeof header !== 'string' || header.length === 0) return 'en';
  // A header long enough to be a denial-of-service attempt is not a header worth parsing.
  // 512 characters is far past any real browser's.
  const text = header.length > 512 ? header.slice(0, 512) : header;

  let best: { locale: PanelLocale; q: number } | null = null;
  for (const raw of text.split(',')) {
    const [tagPart, ...paramParts] = raw.trim().split(';');
    const tag = (tagPart ?? '').trim().toLowerCase();
    if (tag === '') continue;

    const locale = matchLocale(tag);
    if (locale === null) continue;

    let q = 1;
    for (const param of paramParts) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (match !== null) {
        const parsed = Number.parseFloat(match[1]!);
        if (Number.isFinite(parsed)) q = Math.min(1, Math.max(0, parsed));
      }
    }
    // `q=0` means "not acceptable", which is a refusal rather than a low preference.
    if (q === 0) continue;
    // Strictly greater, so an earlier tag at the same quality wins — which is the order the
    // client wrote them in, and the tie-break every browser expects.
    if (best === null || q > best.q) best = { locale, q };
  }

  return best?.locale ?? 'en';
}

function matchLocale(tag: string): PanelLocale | null {
  if (tag === '*') return null;
  const primary = tag.split('-')[0] ?? '';
  if (primary === 'fa' || primary === 'prs' || primary === 'pes') return 'fa';
  if (primary === 'en') return 'en';
  return null;
}
