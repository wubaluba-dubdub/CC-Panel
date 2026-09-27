import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog } from './ui.js';
import { useLocale } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { projectPath } from '../lib/router.js';
import type { ProjectDto } from '../../shared/types.js';

/**
 * The command palette: a visible button in the shell, Ctrl+Shift+P as the reliable keyboard
 * fallback, Cmd/Ctrl+K as best-effort compatibility, and Escape to leave.
 *
 * ── Why there are three entry paths ──────────────────────────────────────────
 * `Ctrl+K` is claimed by Chrome on Windows for the browser's own address bar, and a reservation
 * that deep is not something an in-page handler can defeat: the keystroke simply never reaches
 * `window`. So the palette is openable by something the browser does not claim — a real button
 * in the navigation column, and `Ctrl+Shift+P` — while `Cmd/Ctrl+K` stays bound for the operator
 * whose muscle memory already has it. Which one worked is not the operator's mistake, and the
 * hint printed on the button is the combination that is guaranteed rather than the one that is
 * merely conventional.
 *
 * ── Why it is a `<dialog>` opened with `showModal()` ────────────────────────
 * Top layer, a focus trap, an inert background and a working Escape are four things a hand-made
 * overlay gets wrong, and the first one is the reason there is no alternative: a card clips its
 * contents, so a positioned panel inside one is cut off by the card. `showModal()` puts the
 * palette outside every clipping context on the page.
 *
 * ── Enter and exit ──────────────────────────────────────────────────────────
 * Open: `open` goes true, and the `Dialog` records the opener in the same block as its
 * `showModal()` — which is the only moment that is still before focus moves. Close: every
 * trigger (Escape, the shortcut, the backdrop, the list) goes through the same two-step path —
 * `setOpen(false)`, and then the `Dialog`'s own state machine, which applies `.dialog-closing`,
 * waits for the exit and calls `close()` once. Nothing here calls `close()`, and the palette
 * stays in the top layer until the exit has finished. There is one `<Dialog>` and `open` is a
 * boolean, so a second activation cannot stack a second palette: it can only turn this one off.
 *
 * Focus returns to whatever opened the palette, unless a command has just run: `executed` is
 * what makes `restoreFocus` false for that one close, because a command that navigated or signed
 * out has already decided where focus belongs and the palette must not undo it. Focus itself is
 * the `Dialog`'s to give back — it captured the opener, and it falls back to `<main>` when
 * there is nothing left to return to.
 *
 * ── What it may hold ────────────────────────────────────────────────────────
 * Slugs and dictionary strings. No uuid is listed (the address is one click away on the row),
 * and nothing else is in reach: no secret, no base path, no token, no address.
 */
export function CommandPalette({
  open,
  setOpen,
  projects,
  navigate,
  onCreate,
  onSignOut,
}: {
  /**
   * Lifted to `Shell.tsx` so the visible button can be its opener and can describe the current
   * state with `aria-expanded`. It is still the same boolean: false means closed, and no other
   * value exists.
   */
  open: boolean;
  setOpen: (next: boolean) => void;
  projects: readonly ProjectDto[];
  navigate: (path: string) => void;
  /** Raises the create form: navigate home, then move focus into it. */
  onCreate: () => void;
  onSignOut: () => void;
}): React.JSX.Element {
  const { t, ts, locale, setLocale } = useLocale();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /** True once a command has run, so the focus restore does not fight the navigation. */
  const executed = useRef(false);

  const commands: Command[] = useMemo(() => {
    const language = locale === 'en' ? 'fa' : 'en';
    return [
      ...projects.map((project) => ({
        id: `open:${project.uuid}`,
        label: t('palette.openProject', { slug: project.slug }),
        search: ts('palette.openProject', { slug: project.slug }),
        run: () => navigate(projectPath(project.uuid)),
      })),
      {
        id: 'create',
        label: t('palette.createProject'),
        search: ts('palette.createProject'),
        run: onCreate,
      },
      {
        id: 'audit',
        label: t('palette.goToAudit'),
        search: ts('palette.goToAudit'),
        run: () => navigate('/audit'),
      },
      {
        id: 'locale',
        label: t('palette.switchLocale', {
          language: language === 'en' ? t('common.english') : t('common.persian'),
        }),
        search: ts('palette.switchLocale', {
          language: language === 'en' ? ts('common.english') : ts('common.persian'),
        }),
        run: () => {
          // The same write the language chips make: the operator's language must not wait on a
          // round trip, and a failed write costs the persistence rather than the choice.
          setLocale(language);
          void api
            .patch('/api/settings/locale', { locale: language })
            .catch(() => undefined);
        },
      },
      {
        id: 'signout',
        label: t('app.signOut'),
        search: ts('app.signOut'),
        run: onSignOut,
      },
    ];
  }, [projects, locale, t, ts, setLocale, navigate, onCreate, onSignOut]);

  const needle = query.trim().toLowerCase();
  const matches =
    needle === ''
      ? commands
      : commands.filter((command) => command.search.toLowerCase().includes(needle));
  const selected = matches.length === 0 ? 0 : Math.min(active, matches.length - 1);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Both modifiers kept as they were: a Mac and a PC are not the same key, and neither is
      // the only keyboard this panel has to answer to.
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      // `Ctrl+Shift+P` is the combination that is guaranteed to reach this handler. The `k`
      // bindings stay as best-effort compatibility and are deliberately narrowed to the plain
      // combination, so the page does not claim `Ctrl+Shift+K` as well.
      const reliable = event.ctrlKey && event.shiftKey && key === 'p';
      const compat = key === 'k' && !event.shiftKey;
      if (!reliable && !compat) return;
      // Never a keystroke that belongs to a control the operator is typing into: `input`,
      // `textarea`, `select` and a `contenteditable` region own their own shortcuts, and a
      // global handler that fires in one of them takes the keystroke from the field. The
      // single exception is the palette's own query field, identified by reference rather than
      // by tag — the combination that opened the palette has to be able to close it while that
      // field has focus, or the second activation would do nothing at all.
      if (event.target !== inputRef.current && isTypingTarget(event.target)) return;
      event.preventDefault();
      if (open) {
        setOpen(false);
        return;
      }
      executed.current = false;
      setQuery('');
      setActive(0);
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  useEffect(() => {
    // Only the open half. The close half — and the focus that follows it — is the `Dialog`'s
    // state machine, which waits for the exit before touching focus at all.
    if (open) inputRef.current?.focus();
  }, [open]);

  const run = (command: Command): void => {
    executed.current = true;
    setOpen(false);
    command.run();
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (matches.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((selected + 1) % matches.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((selected - 1 + matches.length) % matches.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(matches[selected]!);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      onBackdrop={() => setOpen(false)}
      restoreFocus={!executed.current}
      title={t('palette.title')}
    >
      <label className="visually-hidden" htmlFor="palette-input">
        {t('palette.title')}
      </label>
      <input
        ref={inputRef}
        id="palette-input"
        className="command-input"
        type="text"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        aria-expanded="true"
        aria-controls="palette-list"
        aria-autocomplete="list"
        {...(matches.length === 0
          ? {}
          : { 'aria-activedescendant': `palette-option-${selected}` })}
        placeholder={ts('palette.placeholder')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onInputKeyDown}
      />
      <ul className="command-list" id="palette-list" role="listbox" aria-label={ts('palette.title')}>
        {matches.length === 0 ? (
          /* Presentational, so the listbox's required children stay options-or-nothing while the
             empty state is still readable by everyone else. */
          <li className="command-empty" role="presentation">
            {t('palette.noMatch')}
          </li>
        ) : (
          matches.map((command, index) => (
            <li
              key={command.id}
              id={`palette-option-${index}`}
              role="option"
              aria-selected={index === selected}
              className={index === selected ? 'command-item command-on' : 'command-item'}
              onMouseMove={() => setActive(index)}
              onClick={() => run(command)}
            >
              {command.label}
            </li>
          ))
        )}
      </ul>
      <p className="hint">{t('palette.hint')}</p>
    </Dialog>
  );
}

/** One entry: what it says, what the filter matches, and what it does. */
interface Command {
  id: string;
  label: ReactNode;
  search: string;
  run: () => void;
}

/**
 * True for a control that owns the keystrokes it receives.
 *
 * The four cases the requirement names, and nothing else: an `input`, a `textarea`, a `select`
 * and a `contenteditable` region are the places an operator types, which is what makes a
 * keystroke arriving there the field's and not the application's. Checked against
 * `instanceof HTMLElement` so an event target that is a document node cannot be read as one of
 * them, and the value is only read inside a `keydown` listener — so this module never touches
 * `HTMLElement` at import time, which is what lets a source scan import it in a Node test.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}
