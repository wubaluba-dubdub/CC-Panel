import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `.dockerignore` must NOT exclude `src/client/**` — the Vite sources the
 * builder stage compiles. `dist` is correctly excluded because the image
 * builds its own; the test checks the sources.
 *
 * What this scan sees: whether any `.dockerignore` rule matches files under
 * `src/client/`. What it does not see: whether a future rule like `src/**`
 * would match — that would require a full glob evaluator.
 */

function parseDockerignore(content: string): string[] {
  const patterns: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    patterns.push(trimmed);
  }
  return patterns;
}

function globMatches(path: string, pattern: string): boolean {
  // Simple glob matching: * matches any characters, ** matches across directories.
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{DOTSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{DOTSTAR\}\}/g, '.*') +
      '$',
  );
  return regex.test(path);
}

describe('.dockerignore must not exclude client sources', () => {
  it('no .dockerignore rule matches src/client/ paths', () => {
    const dockerignorePath = join(import.meta.dirname, '..', '..', '.dockerignore');
    const content = readFileSync(dockerignorePath, 'utf-8');
    const patterns = parseDockerignore(content);

    // Test a representative set of client source paths.
    const clientPaths = [
      'src/client/App.tsx',
      'src/client/main.tsx',
      'src/client/pages/Audit.tsx',
      'src/client/lib/api.ts',
      'src/client/components/Table.tsx',
      'src/client/styles/tokens.css',
      'src/client/fonts/woff2/Vazirmatn Latin.woff2',
    ];

    const violatingPatterns: string[] = [];
    for (const pattern of patterns) {
      // Negation patterns (!) include files, so skip them.
      if (pattern.startsWith('!')) continue;
      for (const path of clientPaths) {
        if (globMatches(path, pattern)) {
          violatingPatterns.push(`${pattern} matches ${path}`);
        }
      }
    }

    expect(
      violatingPatterns,
      `.dockerignore patterns that would exclude client sources: ${violatingPatterns.join('; ')}`,
    ).toEqual([]);
  });

  it('.dockerignore correctly excludes host-built dist (the image builds its own)', () => {
    // The image builds its own dist. The .dockerignore correctly excludes host-built
    // dist to avoid stale artifacts. This test verifies the exclusion is present by
    // checking that `dist` appears as a non-negated pattern.
    const dockerignorePath = join(import.meta.dirname, '..', '..', '.dockerignore');
    const content = readFileSync(dockerignorePath, 'utf-8');
    const patterns = parseDockerignore(content);

    const hasDistExclusion = patterns.some((p) => !p.startsWith('!' ) && p === 'dist');
    expect(hasDistExclusion).toBe(true);
  });
});
