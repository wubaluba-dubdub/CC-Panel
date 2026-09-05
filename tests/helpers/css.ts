import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A very small CSS reader, for the static scans.
 *
 * It exists because every rule this project enforces about the stylesheet is a rule about a
 * *declaration in a context*: a colour literal anywhere but the token file, a duration outside
 * the reduced-motion guard, an animated property that is not on the allowlist. A line-by-line
 * grep cannot see the context, and a real CSS parser is a dependency for a design system of
 * four hundred lines. This walks braces and keeps a stack, which is exactly enough.
 *
 * Comments are stripped first: prose *about* a rule is the point of the rule.
 */

export interface Declaration {
  /** The file, relative to `src/client`. */
  file: string;
  /** 1-based line of the declaration in the original file. */
  line: number;
  /** The enclosing preludes, outermost first: at-rules and selectors. */
  context: string[];
  property: string;
  value: string;
}

export const CLIENT_ROOT = join(import.meta.dirname, '..', '..', 'src', 'client');

export function clientFiles(pattern: RegExp, dir: string = CLIENT_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...clientFiles(pattern, full));
    else if (pattern.test(entry)) out.push(full);
  }
  return out.sort();
}

export function relativeToClient(file: string): string {
  return relative(CLIENT_ROOT, file).split('\\').join('/');
}

/** Strips comments, preserving line numbering so a finding can name a line. */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

/**
 * Reads one stylesheet into a flat list of declarations, each with the stack of preludes it sits
 * inside. An at-rule with no block (`@import`, `@charset`) is reported as a declaration whose
 * property is the at-rule name, so a scan can see it.
 */
export function declarationsOf(file: string): Declaration[] {
  const rel = relativeToClient(file);
  const css = stripCssComments(readFileSync(file, 'utf-8'));
  const out: Declaration[] = [];
  const stack: string[] = [];
  let buffer = '';
  let line = 1;
  let bufferStartLine = 1;

  const flush = (): void => {
    const text = buffer.trim();
    buffer = '';
    if (text === '') return;
    const colon = text.indexOf(':');
    // `@import url(…)` and friends: no colon, or a colon inside a URL. Report the whole thing.
    if (colon === -1 || text.startsWith('@')) {
      out.push({ file: rel, line: bufferStartLine, context: [...stack], property: text.split(/\s/)[0]!, value: text });
      return;
    }
    out.push({
      file: rel,
      line: bufferStartLine,
      context: [...stack],
      property: text.slice(0, colon).trim(),
      value: text.slice(colon + 1).trim(),
    });
  };

  for (const char of css) {
    if (char === '\n') {
      line += 1;
      if (buffer.trim() === '') bufferStartLine = line;
      buffer += char;
      continue;
    }
    if (char === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '));
      buffer = '';
      bufferStartLine = line;
      continue;
    }
    if (char === '}') {
      flush();
      stack.pop();
      bufferStartLine = line;
      continue;
    }
    if (char === ';') {
      flush();
      bufferStartLine = line;
      continue;
    }
    buffer += char;
  }
  flush();
  return out;
}

/** Every declaration in every client stylesheet, in file order. */
export function allDeclarations(): Declaration[] {
  return clientFiles(/\.css$/).flatMap(declarationsOf);
}
