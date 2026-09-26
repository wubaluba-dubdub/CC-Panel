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
    // an event handler — which is what lets the exit transition run.
    const body = client('components/CommandPalette.tsx');
    expect(body).toContain('onBackdrop=');
    expect(body).toContain('onClose={() => setOpen(false)}');
    expect(body).toContain('!event.metaKey && !event.ctrlKey');
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
