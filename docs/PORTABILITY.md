# Portable export and import (R1, R2)

**Design only. Nothing in this document is built.** It specifies the mechanism that
satisfies R1 (a complete panel backup the operator takes on demand) and R2 (uploading
that file into a *different* panel reproduces the first one). Built in M2.6; the
decisions here are recorded before M2.1 because [§4](#4-portable-identity) changes the
Phase 2 schema and the directory layout, and both are cheaper to get right than to
migrate.

Related: [`SECURITY.md`](./SECURITY.md) for the crypto this reuses,
[`DEPLOY.md`](./DEPLOY.md) §*Backup and restore* for the single-instance snapshot this is
**not**.

---

## 1. Why this cannot just be a copy of the database

Every secret in the panel is AES-256-GCM under an HKDF subkey of `PANEL_MASTER_KEY`, with
additional authenticated data of the form `<table>:<rowId>:<column>`. A second panel has a
different master key **by construction**: `SECURITY.md` §*Key rotation* records that the
key is permanent for the life of a database and that there is no rotation procedure, so
two panels never share one.

Therefore **a portable export cannot contain panel ciphertext.** Ciphertext from panel A
is undecryptable noise on panel B, and re-keying it would require the source key to travel
with the file — which is the one thing `DEPLOY.md` says never to do, because the backup and
the key are only safe apart.

So the export **decrypts on the way out and re-encrypts on the way in**, and every other
decision in this document follows from that one:

- the file holds plaintext credentials at the moment it is written, so it must be
  encrypted under its own key ([§5](#5-the-envelope)) — there is no plaintext option;
- the file is a **logical document**, not a database image, so it needs its own version
  independent of the schema ([§9](#9-version-compatibility));
- rows are addressed by portable identity, not by autoincrement id
  ([§4](#4-portable-identity));
- import is the panel accepting a file that a stranger may have written
  ([§7](#7-import-is-untrusted-input)).

### It is not `npm run backup`

| | `npm run backup` / `restore` (M1.6) | Portable export / import (M2.6) |
| :--- | :--- | :--- |
| what it copies | `panel.db`, page-for-page, through SQLite's online backup API | a logical document: settings, projects, credentials, optionally workspace files |
| readable by | **only** the panel whose `PANEL_MASTER_KEY` wrote it | any panel, given the export passphrase |
| carries | everything in the database, as ciphertext, plus the account and the audit log | no account, no audit log, no base path, no panel ciphertext |
| answers | "this panel broke; put it back" | "move to another panel" |

Both are kept. `restore` refusing a snapshot whose audit chain fails at its oldest row —
the shape a foreign key makes — is exactly right for what it does, and is exactly why it
cannot be the answer to R2.

---

## 2. What transfers, and what does not

**Transfers:**

- global panel settings (locale, notification preferences, caps);
- the global hand-edited `settings.json` document (R7);
- global provider credentials — `api_key`, `api_base_url`, header style (R7);
- Telegram configuration — bot token and chat id (R6);
- per project: its UUID, slug, display name, description, creation time, its
  hand-edited `settings.json` document (R5), its provider credentials (R7), its git
  remote when it has one, and — optionally — its workspace files
  ([§6](#6-workspace-files)).

**Does not transfer, and the omissions are the design:**

| Not carried | Why |
| :--- | :--- |
| the admin account, username, argon2 hash | an import that can replace the account is a privilege change wearing a restore's clothes. The target panel keeps its own operator. |
| the TOTP secret and recovery codes | second-factor material for a *different* panel's account. Transplanting it would silently move the operator's authenticator to a machine they did not enrol. |
| sessions | opaque tokens bound to the source panel's rows; a transplanted session is a live credential for a panel that no longer exists, or a collision with one that does. |
| the base path | obscurity is per-install. The target generated its own on first boot and printed it once; overwriting it would lock the operator out of the panel they are standing in front of. |
| the audit log | see below. |
| `PANEL_MASTER_KEY` | it is not in the database and never in a file the panel writes. |
| per-project hook token, panel-wide hook shared secret ([M1.7](../PLAN.md)) | credentials for *this* panel's loopback endpoint. Sharing them across panels destroys the property the two-credential design exists for. **The import generates fresh ones**, which is why it must also regenerate each project's Claude Code settings — see [§4.4](#44-what-import-does-to-a-projects-generated-settings). |
| conversation history and transcripts under a project's `claude-home` | the least redactable content the panel holds: whatever the operator pasted into a turn is in there verbatim, and the export pipeline has no way to scrub it. Not in format `v1`. If it is ever wanted it is an explicit `include: history` flag with its own warning, never a default. |

### The audit log specifically

`audit_log.row_hash` is `HMAC-SHA256` under a subkey of the local `PANEL_MASTER_KEY`, and
`audit_chain.anchor_hash` sits outside the chain. A transplanted log therefore fails
`verify()` at its **oldest** row on the target — which is precisely the
`hint: 'wrong_key_or_genesis'` false alarm that M1.6 added the hint to explain, and
`SECURITY.md` warns that an operator shown a false alarm once will discount the real one.

So the import writes **one row** instead of a history:

```
event:   import.applied
meta:    { fingerprint, exportedAt, sourceInstallId, formatVersion, schemaVersion,
           projectsCreated, projectsRenamed, projectsSkipped, projectsOverwritten,
           workspaceFiles, workspaceBytes }
```

`fingerprint` is the SHA-256 of the export's header bytes — stable, not secret, and enough
to tie two panels' logs together. `sourceInstallId` is the opaque `installId` from the
source's `config/instance.json`, which exists for exactly this kind of question and is not
a secret. No path from inside a workspace, no credential reference, no passphrase.

---

## 3. The export is always encrypted

There is no plaintext option and no "just the settings, unencrypted" mode. The file
contains every API key the operator owns, the Telegram bot token, and possibly their source
code, and its entire purpose is to be moved between machines — over a download, a USB
stick, a chat message, a cloud drive. A format with an unencrypted variant is a format
whose unencrypted variant will be the one used at 2 a.m.

---

## 4. Portable identity

**This is the item that changes Phase 2's schema, and the reason M2.0 exists before
M2.1.**

Autoincrement row ids are not portable. They collide with rows already in the target, they
carry no meaning across instances, and — worse — they appear inside secret AAD, so an id
that shifts on import turns a re-encrypted secret into one that will not decrypt.

### 4.1 Every project carries a UUID

- A `uuid TEXT NOT NULL UNIQUE` column, `crypto.randomUUID()` at creation, never reused,
  never edited, and never derived from the slug or the name.
- **The export references projects only by UUID.** Slugs and display names are attributes,
  not identity, because the operator will rename things.
- **AAD for every new table uses the UUID.** Combined with M1.7's `v2` payload version, a
  project credential's AAD is `secrets:project:<uuid>:<name>` — for example
  `secrets:project:9f8e…:api_key`. The injectivity rule M1.7 states still holds and is
  still what makes this safe: `name` may not contain `:`, so `scope:name` parses
  unambiguously from the right even though `scope` contains one.
- The pay-off is that **AAD is a property of the logical secret, not of where it is
  stored**, so import re-encrypts under the target key with the *same* AAD string and
  nothing has to be rewritten to match a new row id.
- M1.7's design writes `secrets:project:<id>:hook_token`. That string is now
  `secrets:project:<uuid>:hook_token`. Whichever milestone lands first owns the change.

### 4.2 The workspace directory is named by UUID, not by slug

`/data/projects/<uuid>/` with `workspace/` and `claude-home/` inside it.

The alternative — a slug-named directory — makes every rename a recursive move of a
possibly-gigabyte tree, with an agent's `cwd` pointing into the old path, and makes a slug
collision on import a filesystem problem rather than a display one. Naming by UUID means a
rename is one `UPDATE`.

The cost is honest and accepted: a shell prompt reads
`/data/projects/9f8e2c1a-…/workspace`, which is ugly and not memorable. Mitigations: the
terminal always opens in the workspace, the UI shows the slug everywhere and the path as a
copyable string, and `claude-home` sits **beside** the workspace rather than inside it —
which is what keeps the stored credentials outside the file browser's root
([`FILES.md`](./FILES.md) §2) and outside the operator's git repository.

### 4.3 What import does when the UUID already exists — and when the slug does

Three cases, and the third is the one that gets a rule rather than an apology.

| Case | Policy | What the UI shows |
| :--- | :--- | :--- |
| UUID absent from target | **create.** The ordinary case. | `new` |
| UUID already present | **skip, by default.** The existing project is not touched — not its files, not its credentials, not its settings. | `skipped — already here`, with `overwrite` and `import as a copy` offered per project |
| UUID absent, slug taken | **deterministic rename**: `<slug>-2`, then `-3`, first free integer ≥ 2, comparing after Unicode NFC normalisation and case folding. | `renamed: acme-web → acme-web-2` |

- **`skip` is the default because it is the only option that cannot destroy the
  operator's work.** `overwrite` replaces settings, credentials and — if workspace files
  are included — the working tree of a project that may have a week of uncommitted changes
  in it. It is available, per project, from the dry run, never as a global switch, and
  never as the default.
- `overwrite` moves the existing workspace aside to `/data/projects/.replaced-<uuid>-<ts>/`
  rather than deleting it, and the import result names the directory. It is swept by the
  same retention pass as exports ([§10](#10-where-the-file-lives)) after 7 days.
- `import as a copy` mints a **new** UUID, so the copy is a genuinely separate project
  rather than two rows fighting over one identity. Its credentials are re-encrypted under
  the new UUID's AAD.
- **This is not sync.** There is no field-level merge, no last-write-wins, no three-way
  anything. A merge that silently picks a winner per field is how an operator loses a
  credential without a message. If two panels have both moved, the answer is
  `import as a copy` and a human decision.
- **The import result must list every rename it performed**, and the dry run must list them
  before anything is written — a project whose slug quietly changed is a project whose
  bookmarks, scripts and muscle memory quietly broke.

### 4.4 What import does to a project's generated settings

The hook credentials do not transfer ([§2](#2-what-transfers-and-what-does-not)), so for
every project it creates the import must mint a fresh per-project hook token, ensure the
panel-wide shared secret exists, and **regenerate** that project's
`claude-home/settings.json` from the imported source documents plus the new credentials —
see M2.4 in [`PLAN.md`](../PLAN.md), where that file is a build artefact rather than a
document. An import that carried the file verbatim would install another panel's hook URL
and another panel's token, and the first turn would report to nowhere.

---

## 5. The envelope

One file, extension `.ccpx`, laid out as: a cleartext **header**, then a sequence of
AES-256-GCM **frames**, then a **trailer frame** carrying the manifest.

```
┌────────────────────────────────────────────────────────────────────┐
│ magic "CCPX" | u16 headerLen | header JSON (headerLen bytes)        │  cleartext,
│                                                                    │  authenticated
├────────────────────────────────────────────────────────────────────┤
│ frame 0 │ frame 1 │ … │ frame n-1 │ trailer frame                  │  encrypted
└────────────────────────────────────────────────────────────────────┘

frame  ::= u32 plaintextLen | nonce(12) | ciphertext | tag(16)
```

### 5.1 Keys

- A random **32-byte data key** from `randomBytes`, fresh per export. It encrypts every
  frame and never leaves the process in the clear.
- It is **wrapped** by a key derived from an operator-chosen passphrase with **Argon2id**,
  using the same parameter class as the login hash — `m = 65536` KiB, `t = 3`, `p = 1`,
  `hashLength = 32`, from `PASSWORD_ARGON2` in `services/user.service.ts`. The `argon2`
  dependency already supports raw derivation (`hash(pass, { raw: true, salt, hashLength })`),
  so this adds no dependency.
- Wrapping is AES-256-GCM over the 32 raw bytes with **AAD = the header bytes**, which is
  what makes the header authenticated without being secret: a header edited to claim a
  cheaper KDF, a different version, or another panel's `installId` makes the unwrap fail.

### 5.2 The header

Cleartext, so the importing panel can decide before asking for a passphrase or reading a
gigabyte:

```jsonc
{
  "format": "ccpx",
  "formatVersion": 1,          // the envelope + document shape
  "panelVersion": "1.0.0",     // informational
  "schemaVersion": 12,         // max applied migration on the source
  "createdAt": "2026-09-03T09:14:22.418Z",
  "sourceInstallId": "…",      // opaque, from config/instance.json
  "kdf": { "algo": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "<16B base64url>" },
  "wrappedKey": "<nonce.ciphertext.tag, base64url>",
  "frameBytes": 1048576,       // plaintext bytes per data frame
  "contents": { "projects": 4, "workspaces": true }   // for the pre-passphrase summary
}
```

Nothing secret is in it. **It carries no base path** and no project names — `contents` is
counts only, because a header is the part of the file that is readable without the
passphrase.

That split is what lets the import distinguish **a wrong passphrase** (header parses, KDF
runs, unwrap fails) from **a corrupt file** (magic or header JSON does not parse) from
**a file from the future** (`formatVersion` above ours). One message each, and none of them
"decryption failed".

### 5.3 Frames, and why they are framed at all

- Each frame is AES-256-GCM over at most `frameBytes` of plaintext, with a fresh 96-bit
  nonce, and **AAD = `ccpx1:<sourceInstallId>:<createdAt>:data:<seq>`** for a data frame and
  `…:trailer:<seq>` for the trailer.
- Binding `seq` into the AAD makes **reordering** detectable: frame 7's ciphertext will not
  authenticate at position 3.
- Making the trailer's AAD label distinct makes **truncation** detectable: a file cut short
  ends without a trailer frame, and a file whose trailer was replaced by a data frame fails
  its tag.
- Nothing is buffered whole. The exporter streams file bytes into frames; the importer
  decrypts frame by frame. A 4 GB workspace never exists in memory, in either direction.

### 5.4 The manifest is a trailer, not a header

```jsonc
{ "entries": [ { "path": "projects/9f8e…/workspace/src/app.ts",
                 "bytes": 4211, "sha256": "…", "compressed": true,
                 "storedBytes": 1620, "mode": 420 }, … ],
  "totals": { "entries": 812, "bytes": 19004112 } }
```

At the **end**, deliberately. A manifest at the front would have to know every entry's size
and digest before the first byte is written, which means walking and hashing the whole
workspace and then reading it a second time. As a trailer the exporter is single-pass, and
the importer loses nothing because it already streams the whole file to a temp location and
verifies before applying ([§8](#8-when-an-import-fails-halfway)).

Entries are laid end-to-end across the frame stream in manifest order, so the reader
consumes exactly `storedBytes` per entry — the same trick `tar` uses, with no offsets to
disagree with the data.

`compressed` is per entry (`zlib.deflateRaw`), and both sizes are recorded, which hands the
import its compression-ratio check for free ([§7](#7-import-is-untrusted-input)).

### 5.5 Why a bespoke container and not `tar` or `zip`

Recommendation: **our own framing.** The reason is not performance, it is that half of
[§7](#7-import-is-untrusted-input)'s defences become unnecessary rather than merely
implemented. This format **cannot express** a symlink, a hardlink, a device node, a fifo, a
setuid bit, an absolute path, or a directory entry — there is no field for any of them. A
tar reader has to *reject* six entry types correctly on every path through the code; this
has nothing to reject.

The counter-argument is inspectability with standard tools, and it does not survive
[§3](#3-the-export-is-always-encrypted): the payload is ciphertext, so `tar -tf` was never
going to work. An offline `npm run export:inspect -- <file>` prints the header and, given
the passphrase, the manifest.

**What would change my mind:** a requirement that a third party's tooling read the export,
or the format growing past ~200 lines of reader. Then `tar` inside the envelope, with the
entry-type rejection list from §7 restored in full.

### 5.6 The passphrase

- **Minimum 16 characters**, checked against the existing `WEAK_PASSWORDS` list after
  lower-casing. Higher than the 12 the login password requires, and for a concrete reason:
  the login has a progressive delay and single-flight execution in front of it, and this
  file has nothing in front of it but Argon2id on the attacker's own hardware.
- The UI **offers a generated one by default** — 20 base64url characters — because the
  generated one is what will actually be used, and a floor of 16 is only annoying to
  someone typing a phrase by hand.
- **What the UI must say, in these words or better:** *"There is no way to recover this
  file without this passphrase. The panel does not store it, cannot reset it, and cannot
  help you. If you lose it, the file is random bytes — take a new export instead."* The last
  clause matters: while the source panel is alive, a lost passphrase costs one re-export,
  not the data. Once the source panel is gone, it costs everything.
- The passphrase is never logged, never audited, never in a response body, never in the
  export file, and is a `SecretString` from the moment it is parsed.

---

## 6. Workspace files

A workspace is a few kilobytes or several gigabytes, so this is the one part of the export
the operator has to make a decision about — and the UI must let them make it with the number
in front of them.

**Three modes, chosen per export, overridable per project:**

| Mode | Carries | For |
| :--- | :--- | :--- |
| `metadata` | the git remote URL, current branch, `HEAD` sha, and a dirty-file list | a repository that lives on a remote. The target re-clones and checks out the same commit. |
| `files` (default) | the working tree minus the exclusion set below | anything without a remote, and anything with uncommitted work |
| `none` | nothing | moving settings and credentials only |

**Default exclusion set** — matched on directory name at any depth, and applied before the
size estimate so the estimate is the truth:

```
node_modules  .venv  venv  __pycache__  .mypy_cache  .pytest_cache  .ruff_cache
target  build  dist  out  .next  .nuxt  .svelte-kit  .turbo  .cache  .parcel-cache
vendor  Pods  .gradle  .terraform  coverage  .nyc_output  .DS_Store  *.log
```

All of them are either reinstallable from a lockfile or regenerable from source, and
together they are usually most of the bytes. The set is a constant in one file, and it is
**shown in the export dialog with a count of what it excluded**, because a silent exclusion
is how someone discovers at the far end that their build output was load-bearing.

`.env` and other dotfiles are **included**. They are exactly what makes a project usable at
the far end, the whole file is encrypted anyway, and excluding them would be a surprise in
the more dangerous direction. The export summary says how many credential-shaped files it
included, so the operator knows what they are carrying.

### `.git`: include when there is no remote, exclude when there is

- **No remote** → include `.git`. The entire history exists nowhere else; excluding it would
  destroy work, silently, in the operation whose name is "backup".
- **Has a remote** → exclude `.git` by default and record the remote, branch and `HEAD`.
  It is usually the largest single directory in the tree and it is fully reconstructible.
- **Either way, if `git status --porcelain` is non-empty, the uncommitted files are carried
  as files** and the export summary says so. A re-clone does not bring back a dirty tree,
  and "your export omitted the four files you had not committed" is not an acceptable thing
  to learn later.
- The operator can force either direction per project. The default is a default, not a
  policy.

### Size, before anything starts

The export dialog shows, per project and in total: **file count, bytes after exclusions**,
and the volume's free space. Computed by the same walk the export will do, so it cannot
disagree with it.

- ≥ 500 MiB: a warning line naming the largest three directories.
- ≥ 2 GiB: the operator must type the project's slug to continue.
- No hard refusal. It is their data, and a panel that will not export it is worse than one
  that takes eleven minutes.

---

## 7. Import is untrusted input

**This is the largest new attack surface in the project.** There is one user, so the threat
is not a stranger with an account — it is the operator being persuaded to import somebody
else's file, from a forum post, a "here is my panel config" message, or a repository. Every
defence below names the concrete failure it prevents.

### 7.1 Entry paths

Rejected, with the whole import refused rather than the entry skipped:

| Rejected | The failure it prevents |
| :--- | :--- |
| absolute paths (`/etc/cron.d/x`, `C:\…`) | writing outside the volume entirely |
| any component equal to `..` or `.` | `../../data/panel.db` — replacing the database, the account, and the audit log in one entry |
| a component that is empty, or the path not being NFC-normalised | two spellings of one path, so a later containment check passes on a name that resolves elsewhere |
| backslashes anywhere | a `\` is a legal filename byte on Linux and a separator to a Windows reader; the two disagree about where the entry lands |
| NUL or C0/C1 control characters | truncation at the NUL in any C-level consumer, and terminal escape sequences in a filename the panel later prints |
| a leading or trailing space or dot in any component | names that resolve differently across filesystems |
| any entry type that is not a regular file | there is none — [§5.5](#55-why-a-bespoke-container-and-not-tar-or-zip). This row exists so that a future move to `tar` restores it. |
| a path longer than 4096 bytes, or a component longer than 255 **bytes** | the kernel's own limits. Bytes, not characters: a 200-character Persian name is 400 bytes. |

Then, for every entry: **resolve the destination and assert containment before writing a
single byte.** `resolve(root, entry)` must equal `root` or start with `root + sep`, and the
check runs against the *resolved* path — one function, the same one
[`FILES.md`](./FILES.md) §2 specifies, so there is one containment implementation in the
panel and one set of tests for it. Not "check as we go": a check interleaved with writes has
already written the previous entry when it rejects this one.

### 7.2 Decompression limits

Enforced against the manifest's declared figures **and** against reality while inflating,
because a manifest is attacker-controlled:

- **total uncompressed bytes** ≤ `PANEL_IMPORT_MAX_UNCOMPRESSED_BYTES`, default **4 GiB**,
  and additionally ≤ the volume's free space minus a 512 MiB floor — checked before the
  first write, using `statfs`;
- **entry count** ≤ 100 000;
- **per-entry ratio** ≤ 200:1, and **whole-file ratio** ≤ 100:1;
- an entry whose actual inflated length exceeds its declared `bytes` by a single byte is a
  hard abort, not a truncation. A declared-small entry that inflates without end is the zip
  bomb, and the manifest is where it lies about itself.

### 7.3 The body limit, and how the exception is scoped

`BODY_LIMIT_BYTES` is 64 KiB panel-wide (`app.ts`) and the import route is the **one**
exception. Two mechanisms, both encapsulated, because either alone leaks:

1. The import route is registered inside its **own** `register()` child context, and the
   `application/octet-stream` content-type parser that streams the body to disk is added
   *there*. `addContentTypeParser` is scoped to the plugin instance it is registered in, so
   no other route in the panel can be reached with that parser.
2. That parser never buffers and never consults `bodyLimit`; it counts bytes as it writes
   and aborts at `PANEL_IMPORT_MAX_BYTES`, default **2 GiB**, configurable. The route also
   declares a route-level `bodyLimit` equal to that value so the two cannot disagree.

A static scan asserts that exactly one route in `src/server` declares a `bodyLimit` override
and exactly one file adds a content-type parser — the same mechanism as the client-IP and
cookie-ownership scans.

### 7.4 Verify everything, then apply — never verify while applying

The pipeline is strictly ordered, and the order is the security property:

1. stream the upload to `/data/exports/incoming/<token>.ccpx`, mode `0600`, counting bytes;
2. parse the magic and header; check `formatVersion` and `schemaVersion`
   ([§9](#9-version-compatibility)); check the KDF parameters are within bounds
   ([§7.5](#75-the-kdf-parameters-are-attacker-controlled-too));
3. derive, unwrap the data key — a failure here is *"wrong passphrase"* and nothing else;
4. decrypt every frame, verify every tag, verify the trailer exists and authenticates;
5. verify the manifest: every path against [§7.1](#71-entry-paths), every budget against
   [§7.2](#72-decompression-limits), every entry's SHA-256 and length against its bytes;
6. resolve every conflict ([§4.3](#43-what-import-does-when-the-uuid-already-exists--and-when-the-slug-does));
7. **only now** extract to staging and apply ([§8](#8-when-an-import-fails-halfway)).

### 7.5 The KDF parameters are attacker-controlled too

The header states `m`, `t`, `p`. Both directions are attacks and neither is obvious:

- **upward** — a header claiming `m = 4 GiB` is a memory-exhaustion kill of the container,
  delivered by a file. Capped at `m ≤ 262144` KiB (256 MiB), `t ≤ 10`, `p ≤ 4`.
- **downward** — a header claiming `m = 8, t = 1` makes an offline attack on *that file*
  cheap. The panel refuses anything below its own current floor (`m ≥ 65536`, `t ≥ 3`),
  because a file that asks to be weak is either forged or was written by a build that had a
  bug.

### 7.6 The dry run

`POST /api/import/dry-run` runs steps 1–6 and stops. It **writes nothing** outside the temp
file, which it then deletes, and it returns the plan: per project `new | skipped | renamed |
overwrite`, the rename it would perform, file counts and bytes, the hook credentials it
would mint, and every warning.

For this operator the dry run is not a nice extra — it is how the feature becomes usable at
all. The apply endpoint takes the **fingerprint the dry run returned**, so "apply" always
means "apply the thing I was just shown"; a file that changed between the two is a refusal,
not a surprise.

---

## 8. When an import fails halfway

**Decision: staging plus a swap, with the database transaction committed last. No rollback
journal.**

1. Extract into `/data/projects/.import-<token>/<uuid>/…` — on the **same filesystem** as
   the destination, so the final step is a `rename(2)` and not a copy.
2. For each project, in order: if `overwrite`, `rename` the existing directory to
   `/data/projects/.replaced-<uuid>-<ts>/`; then `rename` the staged directory into place.
   These are the operations that can fail for real reasons — `ENOSPC`, `EXDEV`, a directory
   that vanished — so they happen while nothing has been committed.
3. **Then** commit one SQLite transaction: project rows, re-encrypted secrets, settings
   documents, fresh hook credentials, the `import.applied` audit row.

If step 2 fails partway, the renames already done are undone (the replaced directories are
moved back, the new ones removed), the staging tree is deleted, and **nothing is committed** —
the panel's view of the world never contained the half-import. If the process dies between
steps 2 and 3, the volume holds directories with no rows pointing at them: inert, invisible
in the UI, and swept by the retention pass in [§10](#10-where-the-file-lives).

Committing the database **last** is what makes this work: the panel only ever knows about
projects whose files are already in place. The alternative — a recorded rollback log — was
rejected because it is a second mechanism that must itself be crash-safe, and it can only
undo what it managed to record; this design's failure state is indistinguishable from "the
import never happened", with at most some unreferenced bytes.

---

## 9. Version compatibility

Two independent numbers in the header, and keeping them independent is the point: the export
is a **logical document**, so a database migration does not have to bump the file format, and
a format change does not have to touch the schema.

| Situation | Behaviour |
| :--- | :--- |
| `formatVersion` **>** ours | **refuse**, naming both: *"this export is format version 3; this panel reads up to 2. Update the panel."* Reading a format from the future means guessing at a layout, which is the thing `decrypt()` already refuses to do for payloads. |
| `formatVersion` **<** ours | accept, through a reader keyed on that version. One reader today. |
| `schemaVersion` **>** ours | **refuse**, naming both. The document may carry fields this build has nowhere to put, and silently dropping them is a data loss the operator would not be told about. |
| `schemaVersion` **<** ours | **accept.** The target's own migrations have already run against its own database at boot; the version-keyed reader maps the older document forward. This is the ordinary case and it is what "migrate forward through the normal migration path" means here. |

---

## 10. Where the export file lives

**Written to the volume, verified, then fetched — not streamed straight to the browser.**

- `/data/exports/`, directory mode `0700`, files `0600`, owned by uid 10001. Added to
  `ensureDataLayout()` and to `entrypoint.sh`'s `LAYOUT_DIRS`, which is an explicit list
  precisely so this kind of addition is visible.
- Filename `panel-export-<YYYY-MM-DD>-<token>.ccpx`, where `token` is 16 random base64url
  characters — not a sequential id, so the download URL cannot be probed by counting.
- **Why not stream it:** the export must be **verified after writing**, the same rule
  `npm run backup` follows — a snapshot that has not been read back is not a backup — and a
  stream that has already left cannot be verified. It also means an interrupted download
  costs a retry rather than re-encrypting four gigabytes, and the operator can download it
  twice.
- Verification after writing: re-open the file, parse the header, unwrap with the passphrase
  still in memory, decrypt every frame, and check every manifest digest. Only then does the
  export appear in the UI as complete.
- **Retention sweep**, run on boot and after every export: delete exports older than 7 days,
  then keep at most the 3 newest; delete anything under `incoming/` older than 6 hours; and
  delete `.import-*` and `.replaced-*` staging directories older than 7 days. The figures are
  constants in one file. `/data/exports` counts toward the disk figure in
  `GET /api/system/resources` on purpose: it is one of the two things that fills the volume.
- **Both creating and downloading an export are step-up gated.** An export contains every
  credential the panel holds, so it is a "reveal a secret" operation and the rule already in
  `routes/security.ts` applies: a stolen session cookie must not be able to walk off with
  the panel. `POST /api/import/apply` is step-up gated for the same reason from the other
  direction. The dry run needs only a full session — it reveals nothing of the target's.
- Download response: `Content-Disposition: attachment` with an RFC 5987 `filename*`,
  `Content-Type: application/octet-stream`, `Cache-Control: no-store`, `nosniff` (already
  global).

---

## 11. Endpoints

| Route | Session | Notes |
| :--- | :--- | :--- |
| `POST /api/exports` | step-up | body: passphrase, mode, per-project overrides. Answers `202` with the export id; the work runs in a guarded background task, progress from `GET /api/exports/:id`. |
| `GET /api/exports` | full | list: id, createdAt, bytes, state, fingerprint. Never the passphrase. |
| `GET /api/exports/:id` | full | one row, plus progress and the verification result. |
| `GET /api/exports/:id/download` | step-up | the attachment. |
| `DELETE /api/exports/:id` | full | deletes the file now rather than waiting for the sweep. |
| `POST /api/import/dry-run` | full | the upload plus a passphrase; returns the plan and a fingerprint. |
| `POST /api/import/apply` | step-up | takes the fingerprint from the dry run. |

New audit events: `export.created`, `export.downloaded`, `export.deleted`,
`import.dry_run`, `import.applied`, `import.rejected` (with a failure **category** only:
`bad_passphrase`, `bad_format_version`, `bad_schema_version`, `corrupt`, `path_rejected`,
`budget_exceeded`, `kdf_out_of_range`). Every one of them must also gain an entry in M1.7's
`notification-rules.ts`, which is exhaustive over `AuditEvent` — `export.created` and
`import.applied` are among the most valuable alerts the panel can send, since either one
performed by someone other than the operator is a total compromise.

---

## 12. Tests to write

- **Round trip**: export a panel with two projects, credentials and settings; import into a
  panel with a *different* master key; every credential decrypts, every settings document is
  byte-identical, no ciphertext from the source appears anywhere in the target's database.
- **Envelope**: a wrong passphrase, a truncated file, a reordered frame, a flipped
  ciphertext byte, an edited header, a swapped trailer — six distinct, distinguishable
  outcomes, and none of them "decryption failed" except the wrong passphrase.
- **Adversarial entries**: every row of [§7.1](#71-entry-paths), each asserting that
  *nothing was written*, not merely that an error was raised.
- **Budgets**: a 200 MB entry declared as 1 KB; 200 001 entries; a 1000:1 ratio; a
  free-space refusal driven by a stubbed `statfs`.
- **KDF bounds**: `m = 4 GiB` refused without allocating; `m = 8` refused as a downgrade.
- **Conflicts**: the three cases of [§4.3](#43-what-import-does-when-the-uuid-already-exists--and-when-the-slug-does),
  plus a slug collision after NFC normalisation (`acme-café` in two Unicode spellings).
- **Failure halfway**: a `rename` stubbed to throw on the second project leaves zero rows
  committed and the first project's original directory back in place.
- **Absence**: the export file contains no `PANEL_MASTER_KEY`, no session token, no argon2
  hash, no TOTP secret, no base path in any of its three spellings, and no `audit_log` row —
  swept the same way `tests/integration/secret-leak.test.ts` sweeps, and against the
  *encrypted* file as well as the decrypted document.
- **Version matrix**: a format from the future refused; a schema from the future refused; an
  older schema accepted and mapped.
- **Not sync**: importing the same file twice changes nothing the second time.

## 13. Files, when it is built

`src/server/services/export.service.ts`, `import.service.ts`,
`portable-envelope.ts` (header, frames, KDF — the only file that names `ccpx`),
`portable-document.ts` (the version-keyed logical document readers/writers),
`utils/contain-path.ts` (shared with the file browser — see [`FILES.md`](./FILES.md)),
`routes/portability.ts`, a migration adding `exports`, and
`tests/unit/portable-envelope.test.ts`, `tests/unit/portable-document.test.ts`,
`tests/integration/portability.test.ts`, `tests/integration/import-adversarial.test.ts`.
