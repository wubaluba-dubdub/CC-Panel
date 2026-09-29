import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { clientFiles, relativeToClient } from '../helpers/css.js';
import { ALL_TABLES, PROJECTS_TABLE, COLUMN_CH, CELL_PADDING_CH } from '../../src/client/lib/table.js';

/**
 * M2.2's client, as the scans a Node test can actually run.
 *
 * Vitest runs with `environment: 'node'` and the test tsconfig has no `jsx`, so nothing here
 * imports a `.tsx` file — a test that did would fail to compile, not to pass. What is left is
 * source text, which is the right level for most of these rules anyway: they are about *which*
 * fields, *which* attributes and *which* primitives a file reaches for, and every one of them
 * is a decision made while the file is written.
 *
 * Each assertion below says what it does not see; the last test in this file says what none of
 * them can see.
 */

/** Source with comments removed, so a rule is not satisfied by the sentence describing it. */
function code(file: string): string {
  return readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function client(relative: string): string {
  // `clientFiles` matches a file's *name*, and every client file name is unique.
  const name = relative.slice(relative.lastIndexOf('/') + 1);
  return code(clientFiles(new RegExp(`^${name.replace('.', '\\.')}$`))[0]!);
}

describe('M2.2 — the projects screen consumes the ProjectDto and nothing else', () => {
  /**
   * The seven accepted fields, by exclusion.
   *
   * What this sees: every `.ts`/`.tsx` file under `src/client`, comments stripped, for any of
   * the names the API does not return. What it does not see: a forbidden field reached through
   * a computed key or a spread — but no screen here builds one, and the compile-time type is
   * the backstop for the shapes this cannot parse.
   */
  const FORBIDDEN = [
    'displayName',
    'gitRemote',
    'originRef',
    'originAt',
    'sourceInstallId',
    'reviewState',
    'reviewedAt',
    'artefactsJson',
    'origin_ref',
    'origin_at',
    'source_install_id',
    'review_state',
    'reviewed_at',
    'artefacts_json',
    'freeBytes',
    'usedBytes',
    'totalBytes',
    'diskBytes',
    'pathsJson',
  ];

  it('never names a field the project API does not return', () => {
    // Scoped to the files that talk about projects. A wider sweep would fail on the resource
    // widget, whose `usedBytes` and `totalBytes` come from `/api/metrics` and have nothing to
    // do with a project — a rule broad enough to catch an unrelated screen is a rule that gets
    // narrowed until it catches nothing.
    const projectFiles = [
      'pages/Projects.tsx',
      'pages/Project.tsx',
      'components/CommandPalette.tsx',
      'lib/table.ts',
      'lib/api.ts',
    ];
    const offenders: string[] = [];
    for (const relative of projectFiles) {
      const body = client(relative);
      for (const field of FORBIDDEN) {
        if (body.includes(field)) offenders.push(`${relative}: ${field}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares exactly the seven accepted fields on ProjectDto', () => {
    // The positive half: not merely "the screens do not use a forbidden field", but "the type
    // they are checked against has no forbidden field to use". Pinned as an ordered list so a
    // future field cannot arrive quietly in the middle of it.
    const source = readFileSync(
      new URL('../../src/shared/types.ts', import.meta.url),
      'utf-8',
    );
    const body = /export interface ProjectDto \{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(body, 'ProjectDto was not found where it was').toBeDefined();
    const keys = [...body!.matchAll(/^\s*(\w+)\??:/gm)].map((match) => match[1]!);
    expect(keys).toEqual([
      'id',
      'uuid',
      'slug',
      'renamed',
      'isolatedSettings',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('does not treat a project as though it had a path of its own', () => {
    // The address is a uuid and the directory is the server's business; `projectPath()` is the
    // only path-like thing the client may build, and it takes a uuid.
    const body = client('pages/Projects.tsx') + client('pages/Project.tsx');
    expect(body).not.toContain('.path');
    expect(body).not.toContain('workspace');
  });

  it('renders a cell for every column the table definition declares', () => {
    // The type system makes a missing cell a compile error inside `cells:`; this asserts that
    // the record the screen actually writes is the one the spec reads — i.e. that a column was
    // not quietly renamed in one place only.
    const body = client('pages/Projects.tsx');
    const declared = PROJECTS_TABLE.columns.map((column) => column.key);
    for (const key of declared) {
      expect(body.includes(`'${key}'`), `${key} has no cell in Projects.tsx`).toBe(true);
    }
    // And the table is reached through the primitive, not written by hand.
    expect(body).toContain('PROJECTS_TABLE');
    // The only file that may render the element.
    const tableRenderers = clientFiles(/\.tsx$/)
      .filter((file) => /<table\b/.test(code(file)))
      .map((file) => relativeToClient(file));
    expect(tableRenderers).toEqual(['components/Table.tsx']);
  });

  it('gives the uuid column room for a uuid, in both label sets', () => {
    // A budget check in the other direction from `client-tables.test.ts`: that one proves every
    // label fits; this one proves the one column holding *unbounded-looking* machine data is
    // wider than the data itself, so a 36-character identifier never breaks mid-value.
    const uuid = PROJECTS_TABLE.columns.find((column) => column.key === 'projects.colUuid');
    expect(uuid?.size).toBe('uuid');
    expect(COLUMN_CH.uuid - CELL_PADDING_CH).toBeGreaterThanOrEqual(36);
    expect(PROJECTS_TABLE.columns.filter((column) => column.size === 'flex')).toHaveLength(1);
    expect(ALL_TABLES.map((spec) => spec.name)).toContain('projects');
  });
});

describe('M2.2 — the unbuilt tabs are announced, not merely invisible', () => {
  const body = client('pages/Project.tsx');

  /** Every `<button …>` opening tag in the file. */
  const buttons = [...body.matchAll(/<button\b[\s\S]*?>/g)].map((match) => match[0]!);
  const tabs = buttons.filter((tag) => tag.includes('role="tab"'));

  it('puts the tabs in a labelled tablist with one owning panel', () => {
    expect(body).toContain('role="tablist"');
    expect(body).toContain('aria-label={ts(\'project.tabs\')}');
    expect(body).toContain('role="tabpanel"');
    expect(body).toContain('aria-labelledby="tab-summary"');
    expect(body).toContain('tabIndex={0}');
    expect(body).toContain('aria-controls="panel-summary"');
  });

  it('marks every tab with aria-disabled and never with the disabled attribute', () => {
    // The pattern, and the reason it is this one: `disabled` removes a control from the tab
    // order, so a keyboard user would never reach the tab and never learn the milestone that
    // will build it. `aria-disabled` keeps it focusable and announces it as unavailable.
    expect(tabs.length).toBeGreaterThan(1);
    for (const tag of tabs) {
      if (tag.includes('aria-disabled')) {
        expect(tag, `${tag} is aria-disabled and disabled`).not.toMatch(/\sdisabled[=\s>]/);
        expect(tag).toContain('aria-describedby="tab-unbuilt"');
      }
    }
    // The one real tab owns the panel and says so.
    expect(tabs.some((tag) => tag.includes('aria-selected="true"') && !tag.includes('aria-disabled'))).toBe(
      true,
    );
    // The reason is published once, not six times, and it is in the accessibility tree.
    expect(body).toContain('id="tab-unbuilt"');
    expect(body).toContain('className="visually-hidden"');
  });

  it('labels each unbuilt tab with the milestone that will build it', () => {
    const expected: [string, string][] = [
      ['project.tabFiles', 'M2.3'],
      ['project.tabPortability', 'M2.4'],
      ['project.tabTelegram', 'M2.5'],
      ['project.tabSettings', 'M2.6'],
      ['project.tabImport', 'M2.8'],
      ['project.tabTerminal', 'M3'],
    ];
    for (const [key, milestone] of expected) {
      expect(body, `${key} ${milestone}`).toContain(`['${key}', '${milestone}']`);
    }
    expect([...body.matchAll(/\['project\.tab\w+', 'M[\d.]+'\]/g)]).toHaveLength(6);
  });
});

describe('M2.2 — the command palette is a dialog and leaks nothing', () => {
  it('is opened from the one file allowed to render a <dialog>', () => {
    const renderers = clientFiles(/\.tsx$/)
      .filter((file) => /<dialog\b/.test(code(file)))
      .map((file) => relativeToClient(file));
    expect(renderers).toEqual(['components/ui.tsx']);
    // Both close paths, and both through the same controlled setter rather than a `close()` in
    // an event handler — which is what lets the exit transition run. `restoreFocus` is how a
    // command that has just navigated or signed out keeps the palette from undoing it.
    const body = client('components/CommandPalette.tsx');
    expect(body).toContain('onBackdrop=');
    expect(body).toContain('onClose={() => setOpen(false)}');
    expect(body).toContain('restoreFocus={!executed.current}');
    expect(body).toContain('!event.metaKey && !event.ctrlKey');
    // Focus is the `Dialog`'s to give back now: it records the opener in the same block as its
    // `showModal()`. The palette must not hold a second copy of that decision.
    expect(body).not.toContain('document.activeElement');
    expect(body).not.toContain('getElementById');
    expect(body).not.toContain('opener.current');
    expect(body).not.toContain('.close()');
  });

  it('binds both modifier keys and names nothing secret', () => {
    const body = client('components/CommandPalette.tsx');
    for (const secret of ['__BASE__', 'reveal(', 'SecretString', 'token', 'basePath']) {
      expect(body.includes(secret), `the palette mentions ${secret}`).toBe(false);
    }
  });

  it('addresses a project by uuid, never by slug', () => {
    // A link built from a slug would break the moment the label changed — and would put a
    // user-controlled string into an address.
    expect(client('components/CommandPalette.tsx')).toContain('projectPath(project.uuid)');
    expect(client('pages/Projects.tsx')).toContain('projectPath(project.uuid)');
  });
});

describe('M2.2 — every close trigger uses one controlled path', () => {
  const body = client('components/ui.tsx');
  /** The `Dialog` component alone, so a rule is not satisfied by an unrelated helper in the file. */
  const dialog = body.slice(
    body.indexOf('export function Dialog('),
    body.indexOf('export function Status('),
  );

  /** The source of one JSX handler, from its opening brace to the line that closes it. */
  function handler(signature: string): string {
    const start = dialog.indexOf(signature);
    expect(start, `${signature} was not found in Dialog`).toBeGreaterThan(-1);
    const end = dialog.indexOf('\n      }}', start);
    expect(end, `${signature} has no closing line`).toBeGreaterThan(start);
    return dialog.slice(start, end);
  }

  it('intercepts the platform cancel event rather than letting Escape close the dialog', () => {
    // What this sees: the source of the `onCancel` handler, comments stripped — `preventDefault`
    // present, and the handler reaching for the state machine instead of `close()`. What it does
    // not see: that a browser delivered Escape, that anything animated, or that focus moved.
    // Those are `docs/SECURITY.md` §*Manual browser checks*.
    const cancel = handler('onCancel={(event) => {');
    expect(cancel).toContain('event.preventDefault()');
    expect(cancel).toContain('if (dismissable) beginClose();');
    expect(cancel).not.toContain('.close(');
    expect(cancel).not.toContain('onClose(');
  });

  it('calls showModal once and close once, and close only from the finished exit', () => {
    // The whole state machine in two counts. A second `close()` anywhere in the component would
    // be a path that skipped the exit; a second `showModal()` would be a second open with no
    // matching close. `close()` in `finishClose` is the only one, and it follows the
    // `transitionend`/`transitioncancel` listener rather than preceding it.
    expect(dialog.split('dialog.showModal();')).toHaveLength(2);
    expect(dialog.split('dialog.close()')).toHaveLength(2);
    expect(body).toContain("const EXIT_PROPERTY = 'transform'");
    expect(dialog).toContain("event.propertyName !== EXIT_PROPERTY");
    const finish = dialog.indexOf('const finishClose = useCallback(');
    const closeCall = dialog.indexOf('dialog.close()');
    expect(finish).toBeGreaterThan(-1);
    expect(closeCall).toBeGreaterThan(finish);
    // Bounded by the transition itself: no timer and no duration written in TypeScript, so
    // there is no second source of truth for how long the exit takes.
    expect(dialog).not.toMatch(/setTimeout|setInterval/);
    expect(dialog).not.toMatch(/\b\d+(?:\.\d+)?m?s\b/);
    // Listeners are removed on the way out of the `closing` state, including on unmount.
    expect(dialog).toContain("addEventListener('transitionend'");
    expect(dialog).toContain("addEventListener('transitioncancel'");
    expect(dialog).toContain("removeEventListener('transitionend'");
    expect(dialog).toContain("removeEventListener('transitioncancel'");
  });

  it('has an explicit reduced-motion branch that is the stylesheet guard read the other way', () => {
    // The branch lives in the module body — the helper the `closing` effect calls.
    expect(body).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')");
    expect(dialog).toContain('if (exitIsImmediate())');
    expect(dialog).toContain('finishClose();');
    // And the class the branch exists to avoid waiting for.
    const css = client('styles/globals.css');
    expect(css).toContain('.dialog[open].dialog-closing {');
    expect(css).toContain('.dialog[open].dialog-closing::backdrop {');
    // Placed after `.dialog[open]` in the sheet and at a higher specificity than it, or the
    // open dialog would keep `opacity: 1` and the exit would not move at all.
    expect(css.indexOf('.dialog[open].dialog-closing {')).toBeGreaterThan(css.indexOf('.dialog[open] {'));
  });

  it('records the opener before showModal and puts focus back only after close', () => {
    const show = dialog.indexOf('dialog.showModal();');
    const record = dialog.indexOf('opener.current = document.activeElement');
    expect(record).toBeGreaterThan(-1);
    // Immediately before, in the same synchronous block — `showModal()` is what moves focus, so
    // anything later records where focus already went.
    expect(record).toBeLessThan(show);
    const close = dialog.indexOf('dialog.close()');
    const restore = dialog.indexOf('target.focus()');
    expect(restore).toBeGreaterThan(close);
    // The two answers the prompt asks for: the opener when it still exists, `<main>` otherwise.
    expect(dialog).toContain('target.isConnected');
    expect(dialog).toContain("document.getElementById('main')");
    // And the caller's own veto, read when the close lands rather than when it is requested.
    expect(dialog).toContain('restoreRequested.current');
  });

  it('asks the coordinates as well as the target before it will close on a backdrop click', () => {
    // The target test is necessary — it is what keeps a click on the input, the list or a button
    // from ever reaching this handler — and it is not sufficient, because the dialog's own
    // padding is delivered to the same element with the same target. `tests/unit/
    // dialog-backdrop.test.ts` proves the two disagree; this proves the handler consults both.
    const click = handler('onClick={(event) => {');
    expect(click).toContain('if (event.target !== event.currentTarget) return;');
    expect(click).toContain('getBoundingClientRect()');
    expect(click).toContain('isOutsideBox(');
    // The predicate is on the only path that reaches `onBackdrop()`, so a regression back to
    // target equality alone fails here rather than in a browser.
    expect(click.indexOf('isOutsideBox(')).toBeLessThan(click.indexOf('onBackdrop();'));
    expect(click).not.toMatch(/event\.target === event\.currentTarget\)\s*\{?\s*onBackdrop/);
    // `onBackdrop` is optional: a confirmation dialog does not pass it, so a stray click beside
    // "Delete permanently" cannot be how a delete is abandoned.
    expect(body).toContain('if (onBackdrop === undefined) return;');
  });

  it('is idempotent: a second close request while one is in flight is a no-op', () => {
    expect(dialog).toContain("if (phaseRef.current !== 'open') return;");
    expect(dialog).toContain("if (phaseRef.current !== 'closing') return;");
    // Re-opening mid-exit drops the closing state rather than leaving the class on an open
    // dialog, which is the one path that would otherwise strand the exit listeners.
    expect(dialog).toContain("if (phaseRef.current === 'closing') {");
  });
});

describe('M2.2 — a failed step-up keeps the session standing', () => {
  const login = client('pages/Login.tsx');
  /** The dialog alone, so a rule is not satisfied by `Login()`'s own `bad_credentials` branch —
   * which is a *login* failure, where the pre-session genuinely is the end of the road. */
  const stepUp = login.slice(
    login.indexOf('export function StepUpForm('),
    login.indexOf('export function useCachedLocale('),
  );

  it('sends its submission through the one request that opts out of drop-to-login', () => {
    // The behavioural half lives in `tests/unit/step-up-client.test.ts`: `requestStepUp()`'s 401
    // does not fire `onUnauthenticated`, so `forget()` never runs and the shell stays up. What
    // only this file can see is that the dialog actually uses it. Posting to the raw path is
    // exactly the call that returned the operator to the sign-in screen mid-dialog in
    // production, with the deletion still pending behind it.
    expect(login.indexOf('export function StepUpForm(')).toBeGreaterThan(-1);
    expect(login.indexOf('export function useCachedLocale(')).toBeGreaterThan(
      login.indexOf('export function StepUpForm('),
    );
    expect(stepUp).toContain('requestStepUp(password, code)');
    expect(stepUp).not.toContain('/api/auth/step-up');
    expect(stepUp).not.toContain('noStepUp');
    expect(stepUp).not.toContain('noRedirect');
  });

  it('shows one generic message for every credential failure, naming none of them', () => {
    // The server answers `bad_credentials` for a wrong password, a wrong code, a replayed code
    // and a wrong recovery code alike, so the dialog cannot tell them apart — and must not try
    // to. Every credential failure falls through to the default branch's existing localized
    // string; the three conditions that are not about a credential at all (another attempt is
    // running, the operator must wait, the panel is unreachable) keep their own words.
    expect(stepUp).not.toContain('bad_credentials');
    expect(stepUp).toMatch(/else\s*\{\s*setError\(t\('stepup\.failed'\)\);/);
    expect(stepUp).toContain("setError(t('login.inProgress'))");
    expect(stepUp).toContain("setError(t('login.rateLimited'");
    expect(stepUp).toContain("setError(t('error.network'))");
  });
});

describe('M2.2 — what none of these assertions can see', () => {
  it('states the limit in the file that keeps it honest', () => {
    // Layout, focus return, backdrop hit-testing, the exit animation and screen-reader output
    // are all browser behaviour. This suite has no browser, so they are operator checks in
    // `docs/SECURITY.md` §*Manual browser checks* — items 41 and up — and nowhere in this file.
    const security = readFileSync(
      new URL('../../docs/SECURITY.md', import.meta.url),
      'utf-8',
    );
    expect(security).toContain('41.');
    expect(security).toContain('Command palette');
  });
});
