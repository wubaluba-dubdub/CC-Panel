#!/usr/bin/env node
//
// Copies the non-TypeScript files the server needs at runtime into `dist`.
//
// `tsc` emits only what it compiles. The migration runner reads its `.sql` files off
// disk at boot — `readdirSync(join(import.meta.dirname, 'migrations'))` — so a `dist`
// with no `migrations/` directory is a server that opens an empty database and fails
// at the first query with `no such table: audit_log`.
//
// That is not hypothetical. It was the state of every build in this repository until
// M1.6 booted the container for the first time. `npm run build` exited 0,
// `tests/integration/build.test.ts` passed, `dist/server/index.js` existed and
// imported cleanly, and the migration runner's `catch { return }` turned a missing
// directory into a silent no-op. The `catch` is gone too (see `src/server/db.ts`),
// but the real fix is that the build produces a complete `dist`.
//
// Deliberately a script rather than a `cp -r` in package.json: `cp -r` is not portable
// to a Windows shell, and this has to keep working for whoever builds it next.

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Everything `tsc` will not carry across, as `[from, to]` relative to the root. */
const ASSETS = [['src/server/migrations', 'dist/server/migrations']];

let copied = 0;
for (const [from, to] of ASSETS) {
  const source = join(root, from);
  if (!existsSync(source)) {
    console.error(`copy-assets: ${from} does not exist`);
    process.exit(1);
  }
  const target = join(root, to);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  const count = readdirSync(target).length;
  if (count === 0) {
    console.error(`copy-assets: ${from} is empty — nothing was copied`);
    process.exit(1);
  }
  copied += count;
  console.log(`copy-assets: ${from} -> ${to} (${count} files)`);
}

console.log(`copy-assets: ${copied} file(s) copied`);
