/**
 * An audit row's metadata, as pairs.
 *
 * The audit screen used to render `JSON.stringify(entry.meta)` into a cell — which is how the
 * detail column came to be about 350 pixels wider than the card that was supposed to contain it,
 * sitting on the page background. Pairs fix the width problem; two other decisions come with
 * them.
 *
 * **The keys are not translated**, for the same reason the event names are not. They are grep
 * keys: `sessionId` in the panel has to be the `sessionId` in a Telegram message and the
 * `sessionId` in a Railway log line, and an operator searching for the string that appeared on
 * their screen has to find it. A translated key is a key that matches nothing.
 *
 * **Every value is capped and every value is text.** The metadata is built by the panel's own
 * code from fixed shapes, and `AuditService` refuses anything secret-shaped or non-primitive —
 * but it records values *derived from* attacker-controlled input (a secret's name, a request
 * path, a method), and the type the client is handed says `Record<string, primitive>` about a
 * response body that is parsed JSON. So this handles any shape, caps every value, and returns
 * strings: nothing here can grow a cell without bound and nothing can be markup.
 */

/** The longest a single value is rendered at. Longer values are truncated with an ellipsis. */
export const META_VALUE_CAP = 96;

/** How many pairs are shown in the cell. The rest are behind the row expander. */
export const META_INLINE_PAIRS = 3;

export interface MetaPair {
  key: string;
  value: string;
  truncated: boolean;
}

function cap(text: string): { value: string; truncated: boolean } {
  const points = [...text];
  if (points.length <= META_VALUE_CAP) return { value: text, truncated: false };
  // Sliced by code point rather than by UTF-16 unit, so a truncation cannot split a surrogate
  // pair and leave a lone half on the screen.
  return { value: `${points.slice(0, META_VALUE_CAP).join('')}…`, truncated: true };
}

/** One value, by type. A nested value is stringified — and then capped like any other. */
function render(value: unknown): { value: string; truncated: boolean } {
  if (value === null) return { value: 'null', truncated: false };
  if (typeof value === 'string') return cap(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return cap(String(value));
  }
  if (value === undefined) return { value: 'undefined', truncated: false };
  try {
    return cap(JSON.stringify(value) ?? String(value));
  } catch {
    // A cyclic structure cannot come out of `JSON.parse`, but this function is handed a parsed
    // response body and not a promise about one.
    return { value: '[unrenderable]', truncated: true };
  }
}

export function metaPairs(meta: unknown): MetaPair[] {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return [];
  return Object.entries(meta as Record<string, unknown>).map(([key, value]) => {
    const rendered = render(value);
    return { key: cap(key).value, value: rendered.value, truncated: rendered.truncated };
  });
}

/**
 * The exact JSON, for the expander and for the copy button.
 *
 * Compact and not pretty-printed, because this is the string the operator compares with
 * `meta_json` in a backup or with a line in a log: `audit_log.meta_json` holds
 * `JSON.stringify(meta)` and nothing else.
 */
export function rawMeta(meta: unknown): string {
  try {
    return JSON.stringify(meta) ?? 'null';
  } catch {
    return '';
  }
}
