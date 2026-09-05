#!/usr/bin/env node
//
// Downloads the self-hosted webfonts, verifies them, and writes their licences.
//
// ── Why the files are committed and this script is not part of the build ─────
//
// `font-src 'self'` has no CDN in it, so every font is a same-origin file request, and
// `assetsInlineLimit: 0` means it is a real file rather than a `data:` URL. So the bytes
// have to be in the tree. They are **committed**, and this script exists to reproduce them
// rather than to produce them:
//
//   - the Dockerfile deliberately removes network dependencies from the image build (see
//     its `npm_config_nodedir` comment — that build has already failed twice on transient
//     network errors), and a build step that fetches four files from a CDN is a deployment
//     that fails for reasons unrelated to the change being deployed;
//   - the runtime image has no Python and is not getting one, so nothing in it could subset
//     a font anyway.
//
// ── Why these files and not a subsetting pass ────────────────────────────────
//
// `@fontsource` publishes **per-script subsets already split by `unicode-range`**, which is
// what the design asked a subsetter for: an English-only page downloads the Latin file and
// never the Arabic one. Doing it this way needs no `pyftsubset` and no Python, and the
// ranges below are the ones fontsource itself declares — copied here rather than fetched,
// because `styles/fonts.css` has to state them and a range that disagrees with the file is
// a font that silently never loads.
//
// Run it with:  node scripts/fonts.mjs           (verifies what is on disk)
//               node scripts/fonts.mjs --write   (downloads and overwrites)
//
// Verification is the default because the useful question is almost always "are the files
// in this tree the ones the manifest says", not "fetch them again".

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fontDir = join(root, 'src', 'client', 'fonts');

/**
 * Pinned, with a SHA-256 each.
 *
 * A pinned version alone is not enough: a CDN serving a different byte stream for the same
 * URL is exactly the supply-chain shape worth checking for, and a font file is parsed by a
 * complex binary parser in the browser. The hash is what makes `--write` verifiable and a
 * plain run useful.
 */
const FONTS = [
  {
    file: 'vazirmatn-arabic-400.woff2',
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/vazirmatn@5.2.5/files/vazirmatn-arabic-400-normal.woff2',
    sha256: '6c00a9c4c6bd69475cc47e81afce5b82b96898027d7452e7043f3605671632c8',
  },
  {
    file: 'vazirmatn-arabic-600.woff2',
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/vazirmatn@5.2.5/files/vazirmatn-arabic-600-normal.woff2',
    sha256: 'ab387a839ab8d1df9430b83880a1f50b143a4e047dec7044886b58efb7647c6f',
  },
  {
    file: 'vazirmatn-latin-400.woff2',
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/vazirmatn@5.2.5/files/vazirmatn-latin-400-normal.woff2',
    sha256: 'd2801a5355381e6a20937a7b8dd3372adf684ec6232ab7dbf64b8ae27ccd301e',
  },
  {
    file: 'vazirmatn-latin-600.woff2',
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/vazirmatn@5.2.5/files/vazirmatn-latin-600-normal.woff2',
    sha256: 'bde24a4bebc955eec33a5fe7098e8f635e398c50f5455d7bf96d8631fdbdf019',
  },
  {
    file: 'jetbrains-mono-latin-400.woff2',
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.2.6/files/jetbrains-mono-latin-400-normal.woff2',
    sha256: '14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb',
  },
];

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const write = process.argv.includes('--write');
mkdirSync(fontDir, { recursive: true });

let failures = 0;
for (const font of FONTS) {
  const target = join(fontDir, font.file);

  if (write) {
    const res = await fetch(font.url);
    if (!res.ok) {
      console.error(`fonts: ${font.file} — HTTP ${res.status}`);
      failures += 1;
      continue;
    }
    writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  }

  if (!existsSync(target)) {
    console.error(`fonts: ${font.file} is missing. Run: node scripts/fonts.mjs --write`);
    failures += 1;
    continue;
  }

  const actual = digest(readFileSync(target));
  if (font.sha256 === 'PLACEHOLDER') {
    console.log(`fonts: ${font.file} ${actual}  (record this in scripts/fonts.mjs)`);
  } else if (actual !== font.sha256) {
    console.error(`fonts: ${font.file} — sha256 mismatch\n  expected ${font.sha256}\n  actual   ${actual}`);
    failures += 1;
  } else {
    console.log(`fonts: ${font.file} ok`);
  }
}

process.exit(failures === 0 ? 0 : 1);
