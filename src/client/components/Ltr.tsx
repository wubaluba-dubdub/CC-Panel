import type { ReactNode } from 'react';

/**
 * The left-to-right islands.
 *
 * A terminal, a file path, a hash, a commit id, a port, a byte count: in a right-to-left
 * paragraph these do not merely look odd, they **reorder**, and the operator reads that as
 * data corruption rather than as a layout setting. That is a support conversation which
 * starts in the wrong place, so direction is pinned on the container instead of trusted to
 * the paragraph.
 *
 * The full list of what must be an island is in `docs/UI.md`; the ones that exist today are
 * the base path, the TOTP secret and its `otpauth://` URI, recovery codes, every memory, CPU
 * and disk reading, every timestamp inside a technical block, audit metadata, and the client
 * strings in the session list. Phase 3 adds the terminal and Phase 2's later milestones add
 * code, JSON and the file browser's breadcrumb.
 *
 * `unicode-bidi: isolate` comes with `.ltr` in `globals.css`: `direction` alone would set
 * the direction *inside* the element and still let its edges participate in the surrounding
 * run's ordering.
 */
export function Ltr({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <span dir="ltr" className={className === undefined ? 'ltr' : `ltr ${className}`}>
      {children}
    </span>
  );
}

/**
 * Monospaced **and** left-to-right, because everything monospaced in this panel is one of
 * the islands above. Two components would let a caller pick one and forget the other.
 */
export function Mono({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <span dir="ltr" className={className === undefined ? 'ltr mono' : `ltr mono ${className}`}>
      {children}
    </span>
  );
}

/**
 * A block-level monospaced island, for a secret, a URI or a code listing.
 *
 * `overflow-wrap: anywhere` is applied by the class rather than here — a 200-character
 * `otpauth://` URI has no spaces in it, and a block that cannot wrap is a horizontal
 * scrollbar the operator has to find.
 */
export function MonoBlock({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div dir="ltr" className={className === undefined ? 'mono-block' : `mono-block ${className}`}>
      {children}
    </div>
  );
}
