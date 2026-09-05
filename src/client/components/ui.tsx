import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale } from '../i18n/index.js';

/**
 * The primitives. Eight of them, in one file, because each is a handful of lines and the point
 * of having them at all is that a screen cannot invent its own.
 *
 * Everything here obeys the two client rules: **no `style` prop** (`style-src 'self'` blocks a
 * `style` attribute, and the CSSOM path React uses for `style={{}}` has historically been
 * reported as a violation by real browsers), and **logical properties only** in the CSS these
 * classes name. Both are enforced by `tests/integration/client-discipline.test.ts`.
 */

export function Card({
  title,
  children,
}: {
  title?: ReactNode;
  children?: ReactNode;
}): ReactNode {
  return (
    <section className="card">
      {title === undefined ? null : <h2>{title}</h2>}
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  kind = 'default',
  disabled = false,
  type = 'button',
  busy = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  busy?: boolean;
}): ReactNode {
  const className =
    kind === 'primary' ? 'btn btn-primary' : kind === 'danger' ? 'btn btn-danger' : 'btn';
  return (
    <button
      type={type}
      className={className}
      disabled={disabled || busy}
      // Announced rather than merely visual: a disabled button with a spinner tells a sighted
      // operator that something is happening and tells a screen reader nothing at all.
      aria-busy={busy ? true : undefined}
      {...(onClick === undefined ? {} : { onClick })}
    >
      {children}
    </button>
  );
}

/**
 * A labelled input.
 *
 * The label is a real `<label for>` and the id is required rather than generated, because a
 * generated id is one more thing that can differ between two renders and break the association
 * silently. `ltr` puts the field in a left-to-right island: a password, a TOTP code and a
 * base64 token are Latin in both languages, and a caret that moves the wrong way is unusable.
 */
export function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  inputMode,
  hint,
  ltr = false,
  disabled = false,
  autoFocus = false,
  required = false,
  maxLength,
  describedBy,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  autoComplete?: string;
  inputMode?: 'numeric' | 'text';
  hint?: ReactNode;
  ltr?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  required?: boolean;
  maxLength?: number;
  describedBy?: string;
}): ReactNode {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const described = [hintId, describedBy].filter((v) => v !== undefined).join(' ');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        disabled={disabled}
        required={required}
        className={ltr ? 'ltr' : undefined}
        {...(autoComplete === undefined ? {} : { autoComplete })}
        {...(inputMode === undefined ? {} : { inputMode })}
        {...(maxLength === undefined ? {} : { maxLength })}
        {...(described === '' ? {} : { 'aria-describedby': described })}
        // Used once, for the sign-in field, on a page whose only purpose is that field.
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint === undefined ? null : (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  );
}

/**
 * A notice.
 *
 * `role="alert"` on the failure kinds, because an error that appears without being announced is
 * an error a screen-reader user does not know about — and this panel's slowest path (a login
 * padded by up to thirty seconds) is exactly where that matters. Colour is never the only
 * signal: every notice carries words.
 */
export function Notice({
  kind,
  children,
  live = false,
}: {
  kind: 'danger' | 'warn' | 'ok' | 'info';
  children: ReactNode;
  live?: boolean;
}): ReactNode {
  return (
    <div
      className={`notice notice-${kind}`}
      {...(kind === 'danger' ? { role: 'alert' } : live ? { role: 'status' } : {})}
    >
      {children}
    </div>
  );
}

/**
 * Copy to clipboard, with the trade-off stated where it is offered.
 *
 * The clipboard outlives the page and is readable by anything that can paste, which is a real
 * cost for a TOTP secret or a revealed credential — so the warning is next to the button rather
 * than in a document nobody opens. `navigator.clipboard` is unavailable on an insecure origin
 * other than loopback, and the button says so instead of failing silently.
 */
export function CopyButton({ value, label }: { value: string; label?: ReactNode }): ReactNode {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? t('common.copied') : (label ?? t('common.copy'))}
    </Button>
  );
}

/**
 * A modal, on the platform's own `<dialog>`.
 *
 * `showModal()` gives the focus trap, the inert background, the backdrop and Escape-to-close
 * for free — all four of which a hand-rolled modal gets wrong at least once. `onClose` fires
 * for Escape as well as for a button, so a dismissal cannot leave the caller waiting forever on
 * a promise.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** False for a disclosure the operator must acknowledge — Escape is disabled with it. */
  dismissable?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={typeof title === 'string' ? title : undefined}
      onCancel={(event) => {
        // Escape. Refused for a one-time disclosure — the recovery codes are shown once, and a
        // stray keypress must not be how they are lost.
        if (!dismissable) event.preventDefault();
        else onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
    >
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

/** A short, non-blocking status line. `role="status"` so it is announced without stealing focus. */
export function Status({ children }: { children: ReactNode }): ReactNode {
  return (
    <p className="hint" role="status">
      {children}
    </p>
  );
}

export function Badge({
  kind = 'default',
  children,
}: {
  kind?: 'default' | 'ok' | 'warn' | 'danger';
  children: ReactNode;
}): ReactNode {
  return <span className={kind === 'default' ? 'badge' : `badge badge-${kind}`}>{children}</span>;
}
