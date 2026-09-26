import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog } from './ui.js';
import { useLocale } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { projectPath } from '../lib/router.js';
import type { ProjectDto } from '../../shared/types.js';

/**
 * The command palette: Cmd/Ctrl+K, a filtered list of commands, Escape to leave.
 *
 * ── Why it is a `<dialog>` opened with `showModal()` ────────────────────────
 * Top layer, a focus trap, an inert background and a working Escape are four things a hand-made
 * overlay gets wrong, and the first one is the reason there is no alternative: a card clips its
 * contents, so a positioned panel inside one is cut off by the card. `showModal()` puts the
 * palette outside every clipping context on the page.
 *
 * ── Enter and exit ──────────────────────────────────────────────────────────
 * Open: the keydown captures `document.activeElement` **before** `showModal()` moves focus, then
 * the input is focused on the next commit. Close: `cancel` (Escape) and the backdrop click both
 * take the same controlled path — `onClose` sets state, and the `Dialog` effect calls `close()`
 * on the following commit, which is what lets the `display`/`overlay` transition play rather
 * than being cut off by a synchronous `close()` in the event handler. Focus is then returned to
 * the element that opened it, unless a command has just navigated somewhere: focus is already
 * where the operator's action sent it, and stealing it back would be the palette undoing itself.
 *
 * ── What it may hold ────────────────────────────────────────────────────────
 * Slugs and dictionary strings. No uuid is listed (the address is one click away on the row),
 * and nothing else is in reach: no secret, no base path, no token, no address.
 */
export function CommandPalette({
  projects,
  navigate,
  onCreate,
  onSignOut,
}: {
  projects: readonly ProjectDto[];
  navigate: (path: string) => void;
  /** Raises the create form: navigate home, then move focus into it. */
  onCreate: () => void;
  onSignOut: () => void;
}): React.JSX.Element {
  const { t, ts, locale, setLocale } = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /** The element that had focus when the palette opened. */
  const opener = useRef<HTMLElement | null>(null);
  /** True once a command has run, so the focus restore does not fight the navigation. */
  const executed = useRef(false);
  const mounted = useRef(false);

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
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      if (open) {
        setOpen(false);
        return;
      }
      const current = document.activeElement;
      opener.current = current instanceof HTMLElement ? current : null;
      executed.current = false;
      setQuery('');
      setActive(0);
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      mounted.current = true;
      inputRef.current?.focus();
      return;
    }
    if (!mounted.current) return;
    mounted.current = false;
    if (executed.current) {
      executed.current = false;
      return;
    }
    const target = opener.current;
    if (target !== null && target !== document.body && document.contains(target)) target.focus();
    else document.getElementById('main')?.focus();
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
