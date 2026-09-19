import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The client must never see `actorIp`. It is display-only metadata recorded
 * from attacker-controllable input, and nothing in the UI decides anything from
 * it — see `CLAUDE.md` §*No per-IP tracking*.
 *
 * This scan walks every `.ts` and `.tsx` file under `src/client/` and fails if
 * the literal `actorIp` appears anywhere in the source. It catches direct
 * references (e.g. `entry.actorIp`) but does NOT catch:
 *
 * - A spread of a server object that happens to carry the field
 *   (`{ ...entry }` where `entry` has `actorIp`). That path is closed at the
 *   serialisation boundary: `AuditEntryView` in `src/shared/types.ts` declares
 *   `actorIp` as a field, and the audit route maps it explicitly. A component
 *   that destructures `AuditEntryView` would get a type error from the field's
 *   JSDoc comment, not from this scan.
 * - A dynamically constructed property name (`obj['actor' + 'Ip']`). This scan
 *   is pattern-based and cannot see through string concatenation.
 *
 * What it sees: every literal occurrence of the 7-character string `actorIp`
 * in client source files. What it does not see: spreads, computed properties,
 * and minified output (which this project does not produce).
 */

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkDir(full));
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

describe('actorIp must not reach the client', () => {
  it('no .ts or .tsx file under src/client contains the literal "actorIp"', () => {
    const clientDir = join(import.meta.dirname, '..', '..', 'src', 'client');
    const files = walkDir(clientDir);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      if (content.includes('actorIp')) {
        violations.push(relative(join(import.meta.dirname, '..', '..'), file));
      }
    }

    expect(
      violations,
      `actorIp found in client source files: ${violations.join(', ')}. ` +
        `If a spread carries the field, close it at the serialisation boundary (AuditEntryView), not in the component.`,
    ).toEqual([]);
  });
});
