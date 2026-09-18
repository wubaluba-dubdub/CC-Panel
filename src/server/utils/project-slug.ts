/**
 * The canonical form of a project slug, and the one function that produces it.
 * `projects.slug` has a plain byte-wise UNIQUE; on this grammar NFC and case
 * folding are identity operations, so a validator that admits only canonical
 * forms (migration 012's header) is what makes UNIQUE mean "unique after
 * normalisation". No write may bypass it. A validator, not a slugifier: spaces
 * are not replaced, Unicode is not transliterated, nothing is trimmed silently.
 */

/** The exact grammar. Exported so tests pin the pattern itself, not a clone. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export class InvalidSlugError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSlugError';
  }
}

/**
 * Canonicalises and validates a requested slug, or throws {@link InvalidSlugError}.
 * Order: string check, NFC, ASCII lowercasing, then validation of the canonical
 * value; length is measured on that value.
 *
 * Lowercasing is `A-Z` → `a-z` only: full Unicode folding would map U+212A KELVIN
 * SIGN to `k`, letting characters outside the grammar in through the folding step.
 * On what the grammar admits (pure ASCII) the two agree exactly, so nothing
 * stronger is needed.
 */
export function canonicalizeSlug(input: string): string {
  if (typeof input !== 'string') {
    throw new InvalidSlugError('slug must be a string');
  }
  const canonical = input.normalize('NFC').replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (canonical.length === 0) {
    throw new InvalidSlugError('slug must not be empty');
  }
  if (canonical.length > 40) {
    throw new InvalidSlugError(
      `slug is ${canonical.length} characters after normalisation; the maximum is 40`,
    );
  }
  if (!SLUG_PATTERN.test(canonical)) {
    throw new InvalidSlugError(
      `slug must match ^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$ ` +
        `(2-40 lower-case alphanumerics/hyphens, no leading/trailing hyphen): ${JSON.stringify(canonical)}`,
    );
  }
  return canonical;
}
