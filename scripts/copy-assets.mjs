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

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Everything neither `tsc` nor `vite build` carries across, as `[from, to]` relative to the
 * root.
 *
 * The font licences are the M2.1 addition. The OFL requires the licence to travel with the
 * font software, and the fonts themselves are emitted by Vite (hashed, into
 * `dist/client/assets/`) while a `.txt` beside them in the source tree is referenced by
 * nothing and therefore emitted by nothing. So they are copied, and this script runs **after**
 * `vite build` because `emptyOutDir` would otherwise delete them.
 */
const ASSETS = [
  ['src/server/migrations', 'dist/server/migrations'],
  ['src/client/fonts/OFL-Vazirmatn.txt', 'dist/client/OFL-Vazirmatn.txt'],
  ['src/client/fonts/OFL-JetBrainsMono.txt', 'dist/client/OFL-JetBrainsMono.txt'],
];

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

  // A directory that copied as empty is the failure this script exists for; a single file
  // that copied as zero bytes is the same failure one level down.
  const isDir = statSync(target).isDirectory();
  const count = isDir ? readdirSync(target).length : 1;
  if (isDir && count === 0) {
    console.error(`copy-assets: ${from} is empty — nothing was copied`);
    process.exit(1);
  }
  if (!isDir && statSync(target).size === 0) {
    console.error(`copy-assets: ${from} copied as an empty file`);
    process.exit(1);
  }
  copied += count;
  console.log(`copy-assets: ${from} -> ${to} (${count} file${count === 1 ? '' : 's'})`);
}

console.log(`copy-assets: ${copied} file(s) copied`);
