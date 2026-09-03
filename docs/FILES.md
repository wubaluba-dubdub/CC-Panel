# The project file browser (R4)

**Design only. Nothing here is built.** Built in M2.3. Satisfies R4: for each project,
browse its files, download any file, edit any file in the panel, upload new files, plus
create, rename and delete — **all confined to one project's workspace.**

Related: [`PORTABILITY.md`](./PORTABILITY.md) §7.1, which shares §2's containment function;
[`SECURITY.md`](./SECURITY.md) for the response headers this relies on.

---

## 1. The shape

One project, one root: `/data/projects/<uuid>/workspace`. Everything the operator can reach
is under it, and everything is addressed by a path relative to it.

`claude-home/` sits **beside** the workspace, not inside it, and that is on purpose: the
per-project `CLAUDE_CONFIG_DIR` holds the generated `settings.json` with a plaintext API key
in it (M2.4 in [`PLAN.md`](../PLAN.md) §*Storage and leak surface*), so keeping it outside
the root means containment already excludes the stored credentials without a second rule to
remember. It is also outside the operator's git repository, which is the other half of the
same decision.

---

## 2. The containment function is the whole feature

**One function, in one file — `src/server/utils/contain-path.ts` — that every route must
call before any I/O:**

```
resolveInProject(root, userPath) -> absolute path, or throws PathEscape
  1. reject the input on the syntactic rules below, before touching the filesystem
  2. p = resolve(root, userPath)                     // normalises . and .. textually
  3. p = realpathSync(p) for the deepest existing prefix, and realpath(root) once
  4. assert p === root || p.startsWith(root + sep)
  5. return p
```

Step 3 is the one that is easy to leave out and is the whole point: `resolve()` alone
normalises the *text*, so it is satisfied by `workspace/link/../../panel.db` when `link` is a
symlink. Resolving the real path first, and only then asserting containment, is what closes
that. For a path being **created**, the deepest existing ancestor is realpath'd and the new
components are checked syntactically — a file cannot be created through a symlink whose
target is outside.

Syntactic rejections, before any filesystem call: absolute paths; any component equal to `..`
or `.`; empty components; NUL and C0/C1 control characters; backslashes; a component with a
leading or trailing space or dot; a path not equal to its NFC normalisation; a component over
255 **bytes** or a path over 4096 bytes.

**Bytes, not characters.** `ext4`'s limit is 255 bytes and a Persian filename is two bytes
per character, so a 200-character name that looks fine in the UI is 400 bytes and fails at
the kernel. The upload dialog counts bytes.

**And symlinks are refused outright, not merely resolved.** A path whose final component is
a symlink is rejected even when its target is inside the root: following it means the panel's
notion of "this file" and the filesystem's can diverge later, and there is no operator need
here that a real path does not serve. A symlink is still *listed*, marked as one, and is not
readable, writable or downloadable.

### The adversarial list the future test file must cover

Each case asserts **nothing was read and nothing was written**, not merely that an error was
raised:

| Input | Why it is in the list |
| :--- | :--- |
| `../../panel.db`, `../../../etc/passwd` | the base case |
| `%2e%2e%2f`, `%252e%252e%252f` | Fastify decodes the path once; a route that decodes again gets `..` back |
| `....//`, `..;/`, `.../` | normalisers that strip `../` once, or treat `;` as a separator |
| `/etc/passwd`, `C:\Windows\win.ini` | absolute, both flavours |
| `~`, `~/.ssh/id_ed25519` | `~` is not expanded by `resolve()`, so this must fail as a *missing file named `~`*, never as a home-directory read |
| `a\x00b`, `a\nb`, `a\x1b[2Jb` | NUL truncation in a C consumer; a newline in an audit row; an escape sequence in a name the panel prints |
| `dir\..\..\panel.db` | `\` is a legal Linux filename byte and a separator to a Windows client |
| a symlink inside the workspace pointing at `/data/panel.db` | the database, the account, the audit log |
| a symlink inside the workspace pointing at `/etc/passwd` | the host |
| a symlink inside the workspace pointing at `../claude-home/settings.json` | the plaintext API key, one directory up |
| a **symlinked directory** whose target is outside | every path *under* it is textually contained and physically is not |
| `sub/link/../../../panel.db` where `sub/link` is a symlink | safe on its own, escapes after normalisation — the case step 3 exists for |
| a hardlink to `/data/panel.db` | `realpath` cannot see it. Mitigated by the workspace being written only by the panel and the agent, both uid 10001; noted as a residual and the reason mutations are audited with a digest. |
| a path that is exactly `root` | must be allowed for a listing and refused for a write |
| a 300-byte Persian component | the byte-vs-character rule above |

---

## 3. Downloads are always an attachment

`Content-Disposition: attachment` with an RFC 5987 `filename*=UTF-8''…` (so a Persian
filename survives, and an ASCII `filename=` fallback beside it),
`Content-Type: application/octet-stream` **regardless of the real type**,
`Cache-Control: no-store`. `X-Content-Type-Options: nosniff` is already global.

**Why:** serving a workspace's `.html` inline, on the panel's own origin, is stored XSS with
access to the session — the operator's repository is full of files they did not write, and
one of them only has to be a page. `default-src 'none'` reduces what such a page could do,
but `attachment` is the actual fix: the browser never renders it as a document on this
origin.

### Image preview, and a correction worth recording

Preview does **not** need a CSP change. The shipped policy is `img-src 'self' data:`, so a
same-origin image would load today; what stops preview is the panel's own download policy
above, not the CSP.

There are two ways to add preview later and they differ in exactly the way that matters:

1. **A preview route that sends the real image MIME type** — needs no CSP change, and is the
   dangerous one: the panel would be labelling bytes it did not write as a renderable type on
   its own origin, with `nosniff` as the only thing between an allowlist mistake and an
   inline document.
2. **Fetch the bytes under the attachment policy and render from a client-side `blob:` URL** —
   needs `img-src 'self' data: blob:`, and is the safe one: the panel never labels workspace
   bytes as anything but `application/octet-stream`, and the decode happens in the image
   decoder with no document context.

So preview is a later, deliberate decision, and if it is taken the answer is (2) — the option
that *does* change the CSP. Not something to slip in with a MIME lookup table.

---

## 4. The agent and the operator edit the same files

This is a real conflict in this product, not a theoretical one: the whole point is that an
agent is working in the tree the operator is looking at. It is the first two hazards from
[*the same project*](../PLAN.md#the-same-project-a-correctness-hazard-not-a-capacity-one)
minus the git index lock, and it does **not** get the one-agent-per-project lock — the
operator is not a second agent, and a panel that refuses to open a file because an agent is
running cannot be used for the thing it exists for.

**Optimistic concurrency, using the mechanism that already exists for it:**

- `GET` of a file returns `ETag: "sha256-<hex>"` — a strong validator over the bytes the
  client actually loaded.
- `PUT` must carry `If-Match` with that value. The server hashes the file on disk and
  compares; a mismatch is **`412 Precondition Failed`** with `{ "code": "stale_version" }`
  and the write does not happen. A `PUT` with no `If-Match` is `428 Precondition Required` —
  never an unconditional overwrite.
- The UI offers "reload and see what changed" and shows both, never a silent merge.

A digest rather than mtime-and-size: mtime has second granularity on some filesystems and is
preserved by `git checkout`, `tar -x` and `rsync -t`, so an agent rewriting a file to the
same length within one tick passes a weak validator. Re-hashing on save costs nothing at the
2 MiB editor cap below.

**Atomic saves.** Write to `.<name>.<random>.tmp` in the **same directory**, `fsync` it,
`rename` over the target, `fsync` the directory. The mode is read from the existing file and
preserved; a new file gets `0644`; **the execute bit is never set by the panel**. A
half-written `settings.json` can therefore never exist, which matters because a half-written
`settings.json` is a project whose agent will not start.

---

## 5. Limits, because `node_modules` exists

| Limit | Value | Behaviour past it |
| :--- | :--- | :--- |
| editor size | 2 MiB | the file is offered for **download**, not opened. The editor is not a way to load 40 MB into a browser tab. |
| directory listing | 1000 entries per page, cursor by name | paginated; never a recursive walk for a listing |
| upload size | `PANEL_UPLOAD_MAX_BYTES`, default 100 MiB | `413` with `{ "code": "too_large" }` |
| path depth | 64 components | `400` |
| binary detection | a NUL byte in the first 8000 bytes | download only, no editor. The 8000-byte window is git's own heuristic; matching it means the panel and `git diff` agree about what is binary. |

Listings return `{ name, kind: 'file' | 'dir' | 'symlink' | 'other', bytes, mtime, mode }`
and are built from one `readdir` with `withFileTypes` plus one `lstat` per entry —
`lstat`, not `stat`, so a symlink is reported as a symlink rather than as its target.

**A directory listing never crosses into a symlinked directory** and never follows one to
compute a size. Sizes for directories are not computed at all: `du` over `node_modules` on
every listing is a listing nobody waits for.

---

## 6. Uploads: one raw `PUT` per file, not multipart

Recommendation, and a deviation from the obvious: uploads are
`PUT /api/projects/:uuid/files?path=<relative>` with `Content-Type: application/octet-stream`
and the file as the raw body, streamed to a temp file in the destination directory and
renamed into place. **No multipart.**

- The destination comes from the URL and goes through §2 like every other path, so there is no
  second source of filenames. A multipart part's `filename` header is attacker-supplied,
  needs its own sanitisation, and is exactly where traversal bugs live in every other
  product's file upload.
- No `@fastify/multipart`, no busboy: one fewer dependency and one fewer parser on a route
  that accepts 100 MiB from a browser.
- Many files become many requests, which the client issues with a small concurrency limit —
  and which gives per-file progress and per-file errors instead of one opaque failure at 94 %.

The filename still needs sanitising, because the client derives it from what the browser
handed it: NFC-normalise, strip every path component, reject the §2 rejection list, cap at
255 bytes, and refuse a name that already exists unless `?overwrite=1` (which then takes
`If-Match` like any other write). The resulting file is owned by uid 10001 — the uid
`entrypoint.sh` drops to — because the panel is the only writer.

**What would change my mind:** a requirement to upload a whole directory tree in one action
with a browser that cannot do `webkitdirectory` + N requests, or a no-JavaScript fallback.
Neither applies: the client is an SPA.

---

## 7. Audit policy, decided rather than defaulted

**Mutations are audited. Listings and editor reads are not. Downloads are.**

| Action | Audited | Meta |
| :--- | :--- | :--- |
| list, read into the editor | no | — |
| download | **yes** | `file.downloaded`: project uuid, relative path, bytes |
| write, create, rename, delete, upload | **yes** | `file.written` / `file.renamed` / `file.deleted` / `file.uploaded`: project uuid, relative path (and the old path on a rename), bytes, `sha256` |

Reads are excluded because they would drown a 20 000-row capped log: an editor session
browsing a repository is hundreds of reads, and trimming the log to make room for them costs
the authentication history, which is what the log is for. Downloads are the exception because
they are the **exfiltration** path and they are rare — a hundred downloads is a busy day, and
"which files left this panel" is a question worth being able to answer.

**The cost, stated plainly:** there is no record of the operator *viewing* a file. If a
session is stolen, the log will show what was changed and what was downloaded, and will not
show what was read in the editor. That is the trade, and the alternative is a log that has
forgotten last week's logins.

A path is not a secret — it is the operator's own project — but it is untrusted text, so it
goes through `AuditService`'s metadata validation like everything else, which elides a base
path and **throws** on anything credential-shaped. A file named `sk-ant-…` therefore fails the
write loudly rather than being laundered into an append-only log.

---

## 8. Endpoints

All under a **full session**, all inside the base path, all subject to the per-session rate
bucket. None are step-up gated: the workspace is the operator's own code, and demanding a
fresh TOTP code to open a file is how a panel stops being used.

| Route | Does |
| :--- | :--- |
| `GET /api/projects/:uuid/files?path=&cursor=` | listing, paginated |
| `GET /api/projects/:uuid/file?path=` | contents, with `ETag`; `406` when binary or over the editor cap |
| `GET /api/projects/:uuid/download?path=` | the attachment of §3 |
| `PUT /api/projects/:uuid/file?path=` | write, `If-Match` required |
| `PUT /api/projects/:uuid/files?path=` | upload, §6 |
| `POST /api/projects/:uuid/files/mkdir` | create a directory |
| `POST /api/projects/:uuid/files/rename` | `{ from, to }`, both through §2 |
| `DELETE /api/projects/:uuid/file?path=` | delete a file, or an **empty** directory. A recursive delete is not offered: one mis-click on a project root is not a mistake this panel will help anyone make. |

---

## 9. Tests, and 10. Files

Beyond the adversarial table in §2: an `ETag`/`If-Match` round trip including a file changed
underneath; an atomic save asserted by killing the write between `fsync` and `rename` (the
original is intact, the tmp file is swept); a binary file refused to the editor and served to
download; a Persian filename surviving `Content-Disposition` and coming back byte-identical;
a 300-byte Persian component refused; a directory listing that does not follow a symlinked
directory; and a sweep asserting that no route under `/api/projects/:uuid/file*` can reach
`claude-home` by any path in the table.

`src/server/utils/contain-path.ts`, `src/server/services/files.service.ts`,
`src/server/routes/files.ts`, `tests/unit/contain-path.test.ts`,
`tests/integration/files.test.ts`, `tests/integration/files-adversarial.test.ts`.
