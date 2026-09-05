# Importing an unfinished project (R8)

**Design only. Nothing here is built.** Built in M2.8, with two pieces that must land
earlier ([§13](#13-placement-and-what-has-to-land-earlier)). Satisfies R8: the operator
uploads an unfinished project — built with Claude Code or with anything else — and the panel
takes it over, detecting that project's Claude Code configuration and using it as the
panel's configuration for it.

Related: [`PORTABILITY.md`](./PORTABILITY.md) §7 (import is untrusted input) and §8 (staging
and the swap), whose defences this reuses and whose one structural advantage it loses;
[`FILES.md`](./FILES.md) §2, whose containment function every path here goes through;
[`SECURITY.md`](./SECURITY.md) for the egress rules the clone path lives under.

---

## 1. The feature is not "adopt the settings". It is surface, review, neutralise.

**Start here, because it inverts the feature.**

The panel gives each project its own `CLAUDE_CONFIG_DIR` (`claude-home`), so the
`settings.json` the panel generates is that project's **user-level** file — the *lowest*
level of Claude Code's precedence chain. Highest first, as recorded in
[`PLAN.md`](../PLAN.md) §M2.4:

| | Source | Who owns it |
| :--- | :--- | :--- |
| 1 | managed / enterprise settings | not us |
| 2 | `claude --settings <file>` | the panel, if it uses it — [§11](#11-what-the-settings-model-must-accommodate) |
| 3 | `<workspace>/.claude/settings.local.json` | **whoever wrote the archive** |
| 4 | `<workspace>/.claude/settings.json` | **whoever wrote the archive** |
| 5 | `<claude-home>/settings.json` | the panel |

So an uploaded project's Claude Code settings **do not need to be adopted in order to take
effect.** They already will, the moment an agent starts in that workspace, whether or not
the panel ever reads them. Two files inside the tree the operator just uploaded outrank
everything the panel writes.

That is the whole reason for almost every rule below. The operator's requirement — "detect
it and use it" — is satisfied by making those files **visible and governed**. The danger is
that today they would be neither: an agent would start, read a stranger's `hooks`, and run
a stranger's command lines inside the container that holds `PANEL_MASTER_KEY`, every stored
credential and the audit chain — and the panel would have no record that a settings file
existed at all.

### 1.1 One refinement, because the reframe is not quite unconditional

Some of what a workspace file supplies is gated on Claude Code's **folder-trust** prompt —
[`PLAN.md`](../PLAN.md) §M2.4 records that `env` values arriving from project or local
settings are gated on folder trust, and credential-shaped ones additionally on an approval
dialog, while the user-level file the panel writes is not. So "it takes effect" is, for part
of the surface, "it takes effect once somebody says yes".

This makes the case *worse*, not better, and it is worth being precise about why:

- The prompt is one blind yes/no in a terminal, asked once per directory, and it will be
  asked immediately after the operator uploaded the thing. They will say yes. It looks like
  consent and carries no information.
- The panel cannot lean on the boundary between gated and ungated, because the boundary is a
  property of a Claude Code release and not of this design. A key that is gated today is one
  release away from not being.

**So the design assumes everything in the workspace outranks the panel and takes effect.**
Where folder trust helps, it is a second layer the panel did not build; it is never the
reason a class is treated as safe. What the panel adds is the thing the trust prompt cannot:
telling the operator *what is in the file* before anything runs.

### 1.2 What "adopt" still legitimately means

Adoption is not needed for effect, but it is needed for two other things, and they are the
operator's actual requirement:

1. **The panel's own view has to be true.** M2.4 shows the effective merge with per-key
   provenance. A key that exists only in the workspace has to appear there as coming *from
   the workspace*, or the screen is a lie about what the agent will do.
2. **What the operator asked for is that the panel own the configuration.** So the safe
   classes are **lifted** into the panel's per-project `settings.json` document, where the
   panel's editor shows and edits them, and the workspace copy is rewritten to stop
   competing. That is what the INERT row in [§5](#5-classification-the-core-of-the-design)
   exists for.

---

## 2. Two arrival paths, one pipeline

**Decided by the operator: both paths are wanted.** A ZIP upload and a clone from a git URL.

**This is the load-bearing constraint of the whole design.** The two paths may differ *only*
in how bytes reach staging. From the moment a tree exists in staging there is exactly one
scanner, one classifier, one approval record and one promoter, and neither path may reach a
workspace by any other route.

The reason is not elegance. Two arrival paths that each validate their own input is how one
of them ends up with a check the other has — and it will be the path used less often that is
missing it, which is the path an unusual project arrives by. A check that exists on the
common path and not on the rare one is worse than no check, because it is the one that gets
trusted.

```
  ZIP upload ─┐
              ├─→  /data/projects/.import-<token>/<uuid>/workspace     (staging)
  git clone ──┘                    │
                                   ▼
                     scan → classify → report → approve → promote
                                   │
                                   ▼
                       /data/projects/<uuid>/         (rename(2), same filesystem)
```

- **Raw bytes:** `/data/exports/incoming/<token>.zip`, mode `0600`, byte-counted as it
  streams. This is the directory [`PORTABILITY.md`](./PORTABILITY.md) §7.4 already streams an
  import upload into and §10 already sweeps at boot; it is the arrival area for an uploaded
  blob, not only for a `.ccpx`. **No new directory.**
- **Staging:** `/data/projects/.import-<token>/`, which is §8's staging path, chosen because
  it is on the **same filesystem** as the destination so promotion is a `rename(2)` and not a
  copy. Same requirement here, same directory.
- **The clone path skips the first step entirely** — git writes into staging directly, there
  is no archive. *That is the only permitted difference between the two paths*, and it is the
  only one this document allows.

### 2.1 What enforces that they cannot diverge later

A static scan, in the style of the `resolvePublicOrigin` and `api.telegram.org` scans (and
using the same comment-stripping rule, so prose about the policy is not an offender):

- `promoteStaged(` appears in exactly **one** file under `src/server` besides its own
  definition;
- the two arrival modules import **neither** the promoter nor the classifier;
- exactly one file writes under `/data/projects/<uuid>` outside staging.

A scan and not a review, for the same reason the client-IP rule is a scan: the property has
to survive somebody adding a third arrival path in eighteen months without reading this
document.

---

## 3. The archive is untrusted input, and R8 gives back the surface decision 3 removed

[`PORTABILITY.md`](./PORTABILITY.md) §5.5's whole argument for a bespoke export container was
that it **cannot express** a symlink, a hardlink, a device node, a fifo, a setuid bit, an
absolute path or a directory entry — so six rejections became structurally impossible rather
than merely implemented, and "a tar reader has to reject six entry types correctly on every
path through the code" became a sentence about somebody else's problem.

A ZIP or tarball of somebody's project can express all of them. **The entry-type rejection
list §7.1 keeps as a placeholder for a future move to `tar` is now needed for real**, and it
has to be right on every code path.

### 3.1 Reused unchanged — and reuse is mandatory, not encouraged

| Reused | From | Note |
| :--- | :--- | :--- |
| the entry-path rejection list | [`PORTABILITY.md` §7.1](./PORTABILITY.md#71-entry-paths) | absolute paths, `..`/`.`, empty components, non-NFC, backslashes, NUL and C0/C1, leading/trailing space or dot, 4096-byte path / 255-**byte** component |
| the containment function | [`FILES.md` §2](./FILES.md#2-the-containment-function-is-the-whole-feature) | `resolveInProject`, including the `realpath` step. **Writing a second one for imports is not acceptable** — one implementation, one adversarial test table |
| decompression budgets | [`PORTABILITY.md` §7.2](./PORTABILITY.md#72-decompression-limits) | total uncompressed bytes, entry count ≤ 100 000, per-entry ratio ≤ 200:1, whole-file ≤ 100:1, and a declared size that under-states reality is a hard abort |
| the body-limit exception | [`PORTABILITY.md` §7.3](./PORTABILITY.md#73-the-body-limit-and-how-the-exception-is-scoped) | one child `register()` context, one content-type parser, one route-level `bodyLimit`, and the static scan that keeps it to one |
| verify then apply | [`PORTABILITY.md` §7.4](./PORTABILITY.md#74-verify-everything-then-apply--never-verify-while-applying) | never extract into a live workspace. You cannot verify while applying |
| staging plus a swap | [`PORTABILITY.md` §8](./PORTABILITY.md#8-when-an-import-fails-halfway) | renames first, database transaction committed last |
| the sweeps | [`PORTABILITY.md` §10](./PORTABILITY.md#10-where-the-export-file-lives) | `incoming/` older than 6 hours, `.import-*` older than 7 days |
| free space re-checked during the write | [`PLAN.md`](../PLAN.md) decision 4 | a check that ran once before a four-gigabyte extraction answers a question about a disk that no longer exists |

### 3.2 New, and the first one removes most of the rest

**Recommendation: accept ZIP only, and never read a ZIP entry's external attributes.**

A ZIP entry has no type field beyond "is this name a directory". Symlinks, executable bits
and setuid exist in ZIP only as Unix mode bits inside the *external file attributes*, which
a reader is free to ignore — and a reader that ignores them **cannot create a symlink**, a
setuid file or an executable, because there is no other field that asks for one. Hardlinks,
device nodes and fifos have no ZIP representation at all.

So one rule — *every entry is written as a regular file with a fixed mode* — retires the six
rejections, in the same spirit as §5.5's bespoke container and for the same reason: a
defence that cannot be got wrong beats six that can.

What it costs, stated plainly:

- **A `.tar.gz` has to be repacked** by the operator. This is the price, and it is why the
  decision is worth arguing rather than assuming. It is one command on the machine the
  archive came from, and the alternative is six correct rejections in a tar reader.
- **The execute bit is lost.** A project whose build runs `./scripts/build.sh` needs a
  `chmod` afterwards. [`FILES.md`](./FILES.md) §4 already says the panel never sets an
  execute bit, so this is consistent rather than new — but the import report must say which
  entries *claimed* to be executable, so the operator knows what to chmod rather than
  discovering it from a build failure.

**What would change my mind:** an operator requirement to accept a tarball directly, or the
clone path turning out to cover the Linux case well enough that repacking never comes up. If
tar is ever accepted, §7.1's entry-type list is restored in full and tested per type — and
that test file is a prerequisite of the feature, not a follow-up.

Still needed, because ZIP can express them:

| New rejection | The failure it prevents |
| :--- | :--- |
| two entries for one path | the scanner reads the first and the extractor writes the second. A review that describes different bytes from the ones that land is worse than no review |
| a local header disagreeing with the central directory | the classic ZIP parsing ambiguity: two readers, two different archives, one file. Read the central directory and refuse a mismatch |
| an encrypted entry | it cannot be scanned, so it cannot be reviewed, so it must not be written |
| multi-disk / spanned archives | a format the panel will never assemble correctly and does not need |
| a ZIP64 entry over the byte cap | ZIP64 itself is fine and necessary; the declared size is still attacker-controlled and still checked against reality while inflating |
| an entry name that is not valid UTF-8 | ZIP's legacy code-page mess. A name the panel cannot render is a name the review screen cannot show |
| a `.zip` whose entries all share one top-level directory | not a rejection — a **normalisation**. GitHub's "Download ZIP" wraps everything in `repo-main/`, and importing that verbatim gives a workspace whose only child is a directory. Strip a single common root, say so in the report, and never strip two |

### 3.3 The reader must not be the writer

Node ships neither a ZIP nor a tar reader, so this needs a dependency, and the binding
requirement is not convenience: **the library reports entries and hands over bytes; the panel
decides and writes.** A library with an `extractTo(dir)` convenience method is a library that
has already made every decision in §3.2 on the panel's behalf, in code the panel does not
control, before the classifier has seen anything.

Criteria, in order: streaming entry-at-a-time reads with no temporary full extraction; entry
metadata exposed *before* the bytes; no filesystem writes of its own; a clean
`npm audit --omit=dev`; and small enough to read. `yauzl` is the obvious candidate on that
list. **The choice is made by the milestone that builds it, after running the audit** — this
document should not pin a version it has not verified, and the pinned-versions table in
[`CLAUDE.md`](../CLAUDE.md) is where the answer goes.

---

## 4. The clone path has a different threat profile, and saying "an import" hides it

The two paths are not one thing wearing two hats. What each brings is nearly disjoint, and a
design that treated them as the same would defend one against the other's threats.

**What the archive path brings and the clone path does not.** An archive containing a `.git`
directory carries a **stranger's `.git/config` and `.git/hooks` verbatim**. A clone does not:
git writes a fresh config from its own defaults and the remote's advertised refs, and it
**does not transfer hooks** — hooks live outside the object database and are not fetched. So
that entire class is absent on the clone path. It is [§6](#6-git-the-history-is-kept-and-hook-execution-is-neutralised)'s whole subject and it applies to exactly one of the two paths.

**What the clone path brings and the archive path does not.**

### 4.1 The URL is attacker-influenced input, and one scheme is remote code execution

`git clone "ext::sh -c whoami"` runs a command. The `ext::` transport exists to let a
repository be reached through an arbitrary program, and it takes that program from the URL.
There is no safe way to hand git an unvalidated URL.

So, in this order:

1. **Parse the URL and allow `https:` only.** Not `http:` (a clone in the clear, over a
   network the panel does not control), not `ssh:` or `git@host:path` (needs a key the panel
   should not hold), not `file:` (reads the volume), not `git:` (unauthenticated and
   unencrypted), and emphatically not `ext:` or any other `<name>::` form.
2. **Belt: `GIT_ALLOW_PROTOCOL=https`** in the subprocess environment, so git itself refuses
   anything else even if the parse is wrong — including a protocol reached by *redirect*,
   which the parse cannot see.
3. **Refuse a URL containing userinfo** (`https://user:token@host/...`), and this one is
   worth its own line: git writes the remote URL into `.git/config` **verbatim**. A personal
   access token in the URL therefore becomes a plaintext credential inside the workspace —
   which the file browser will happily display, the export will happily carry, and a `git
   push` will happily send. Credentials belong in the panel's encrypted store. The refusal
   message says that rather than "invalid URL".
4. **No credential helper.** `-c credential.helper=` (empty) so the clone cannot pick up a
   stored or system helper, and `-c credential.interactive=false`.

**Private repositories are therefore out of scope for the clone path**, deliberately and with
the reason stated in the UI: a private clone needs a credential, a credential in a URL is a
credential in the workspace, and a credential in the panel's store needs a git credential
helper that R8 does not build. The archive path covers a private repository — the operator
clones it themselves and uploads the ZIP, `.git` and all, which is exactly what
[§6](#6-git-the-history-is-kept-and-hook-execution-is-neutralised) is for.

### 4.2 A hung clone is the worst failure shape available

`GIT_TERMINAL_PROMPT=0`, and it is not optional. Without it a URL that needs authentication
makes git block **forever** on a username prompt nobody can see, and the operator gets a
spinner with no output and no error — the single worst outcome for a non-expert, because it
is indistinguishable from a slow clone of a large repository. Also `GIT_ASKPASS` and
`SSH_ASKPASS` pointed at a program that produces nothing, and `-c core.askPass=`, because
each of the three is a separate way back to a prompt.

And then a **wall-clock timeout on the subprocess regardless** — 10 minutes, configurable —
because a server that answers slowly forever is not covered by any of the above. On timeout:
kill the process group (not just the child; git spawns `git-remote-https`), sweep staging,
and report `clone_timeout` distinctly from `clone_failed`. A timeout and a failure call for
different next actions, and collapsing them is the same mistake `telegram:test` was written
to avoid.

### 4.3 Symlinks come back on this path

The archive path retires symlinks by never reading a mode field. Git has a mode field it
*must* read: a symlink is a blob with mode `120000`, and a checkout creates a real one. So
the clone path would reintroduce exactly the entry type §3.2 removed.

**`-c core.symlinks=false`.** Git then checks a symlink out as "a small plain file that
contains the link text" — the same outcome the ZIP rule produces, from git's own
configuration rather than from a scan afterwards. A scan afterwards would be the wrong shape
anyway: it would run after the bytes were on disk, which is the "verify while applying" that
[`PORTABILITY.md`](./PORTABILITY.md) §7.4 exists to forbid.

The staged tree is still walked through [`FILES.md`](./FILES.md) §2's containment function
before promotion — belt for the braces, and the thing that catches whatever the next version
of git does differently.

### 4.4 Submodules, and why the answer is never "resolve them"

**`--no-recurse-submodules`, always, with no option to change it.**

A recursive clone fetches URLs **named by the repository being cloned**. Every rule in §4.1
is about the one URL the operator typed; a submodule is a URL a stranger typed, fetched by
the same subprocess, and `.gitmodules` can name any of the schemes §4.1 refuses. Recursion
would hand the URL allowlist straight back to the archive's author.

So: no recursion, and the submodule list is **surfaced as something the operator can act on**
rather than resolved silently or dropped silently. The report lists each submodule's path and
URL from `.gitmodules`, marked "not fetched", with the plain-language consequence — that
directory will be empty and the build may need it. Initialising one is then a deliberate act
in a terminal, in Phase 3, by an operator who has read the URL.

### 4.5 The proxy, which is a different mechanism here

`PANEL_OUTBOUND_PROXY` is an **undici dispatcher**. A git subprocess is a different mechanism
entirely and will not use it, and neither will it read `http_proxy` in a way the panel
controls.

**The clone path passes `-c http.proxy=<value>` when the variable is set.** Doing nothing
would make the local-development case fail with a network error indistinguishable from a
wrong URL, which is precisely the mistake [`CLAUDE.md`](../CLAUDE.md) records about Node's
`fetch` and Telegram — and repeating a documented mistake in a second place is worse than
making it once.

The exposure is genuinely smaller here and that is why the answer differs from Telegram's. A
Telegram request carries the **bot token in its URL path**, so a proxy hop sees a credential;
a clone URL carries no credential *because §4.1 refuses one that does*. What the hop sees is
which repository was cloned, which is not nothing and is worth one line in the UI, but it is
not a secret leaving the panel. The
[M1.8 decision](../PLAN.md#decisions-taken-in-m18-2026-09-05) that the variable stays unset
in production is unchanged; this is about the local case it exists for.

### 4.6 git is not in the image

The runtime stage of the `Dockerfile` installs `ca-certificates` and `util-linux`. **There is
no git.** The clone path therefore has a prerequisite that is a change to the image, not to
the server: `git` in the runtime stage, with `--no-install-recommends`.

Worth stating rather than discovering: it is a package to keep patched, and it is the largest
single addition the image has taken since M1.6. The cost is shared, though —
[`PLAN.md`](../PLAN.md)'s concurrency policy gives a second agent in one project a **git
worktree**, so Phase 3 needs git in the image regardless. Whichever milestone lands first
adds it, and the other one stops needing to.

---

## 5. Classification: the core of the design

Every Claude Code artefact in an uploaded tree falls into one of six classes, and the policy
differs per class because the *consequences* differ per class. A single "import settings?"
switch would be one decision standing in for six.

| Class | What is in it | Default | What the operator is shown |
| :--- | :--- | :--- | :--- |
| **INERT** | `model`, `outputStyle`, `theme`, `verbose`, `includeCoAuthoredBy`, `cleanupPeriodDays` | **adopted automatically** | a list, after the fact |
| **INSTRUCTION** | `CLAUDE.md`, `CLAUDE.local.md`, nested `CLAUDE.md`, `.claude/commands/`, `.claude/agents/`, `.claude/skills/` | **kept**, never presented as inspected | counts and paths, per directory |
| **EXECUTABLE** | `hooks`, `apiKeyHelper`, `statusLine`, `mcpServers`, `.mcp.json`, `.claude/hooks/` scripts | **stripped**, per-item approval | the **exact command line, verbatim** |
| **PERMISSION-WIDENING** | `permissions.allow`, `permissions.defaultMode`, `permissions.additionalDirectories`, `sandbox.*`, `allowManagedPermissionRulesOnly` | **stripped**, per-item approval | the rule, and what it stops gating |
| **CREDENTIAL** | `env` entries holding `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` or anything credential-shaped, `.claude/.credentials.json`, `.env` / `.env.local` / `.env.*` anywhere in the tree | **quarantined** | *which file held one*, never the value |
| **UNKNOWN** | any key the classifier does not recognise | **stripped**, per-item approval | the key and its value, as JSON |

### 5.1 INERT — adopt, and it is the only class that is automatic

These change what the model does, not what runs. Adopting them is the requirement: they are
lifted into the panel's per-project `settings.json` document, where M2.4's editor owns them,
and they appear in the effective merge with provenance `project`.

`model` deserves one note because it is the one that costs money: an uploaded project pinning
an expensive model is INERT and still worth a line in the report, since the operator will be
paying for it on the first turn.

### 5.2 INSTRUCTION — keep, count, and never claim they were read

These are not code. They are instructions that **every future session in that project will
follow**, which is a different thing from code and not a smaller one: a `CLAUDE.md` that says
"always run `curl … | sh` before starting" is a sentence, and the agent is the thing that
executes sentences.

So they are kept — deleting the operator's project documentation is not the panel's business —
and surfaced with counts and paths per directory, and the UI must not imply the panel has
inspected them. The honest line is *"3 instruction files, 1 command, 2 agent definitions —
the panel has not read them"*, and it says that because the alternative is a green tick next
to unread text, which is worse than no tick.

Two things inside this class are worth reporting individually, because their effect is not
instruction-shaped:

- an **agent definition's frontmatter** can carry `tools:` — a tool grant, which behaves like
  the permission-widening class even though the file is prose. Report every `tools:` and
  `model:` line found under `.claude/agents/`.
- a **skill's** `allowed-tools` is the same shape. Report it the same way.

Neither is reclassified, because they are not executed directly and because a class boundary
that moves depending on a file's contents is a class boundary nobody can predict. They are
reported.

### 5.3 EXECUTABLE — stripped by default, and this is the whole security argument

Each of these is a **command line that Claude Code runs on its own initiative**: `hooks` on
tool events, `apiKeyHelper` when it wants a credential, `statusLine` repeatedly while the
session is open, `mcpServers` as a stdio child process.

Adopting them from a downloaded archive is remote code execution inside the container that
holds `PANEL_MASTER_KEY`, every stored credential, the audit chain and its HMAC subkey. Not
"a risk" — that is what it is, exactly, with no qualifier.

- **Stripped by default**, with per-item approval, and the approval screen shows the **exact
  command, verbatim**, not a summary and not a truncation. A command the operator cannot read
  in full is one they cannot judge.
- The command string is untrusted text on its way to a screen, so it goes out under the same
  rules as any other: no shell interpretation anywhere in the panel, and control characters
  and escape sequences rendered rather than emitted — a `statusLine` containing
  `\x1b[2J\x1b[1;1H` would otherwise clear the review screen it is being displayed on.
- Approving one is **step-up gated** ([§12](#12-audit-and-notification)), because it is a
  privilege grant and not a preference.
- `.claude/hooks/` **scripts** are files, not keys: they stay in the workspace (they are the
  operator's repository content), they are never made executable, and nothing in the panel's
  generated settings references them until the corresponding `hooks` entry is approved. A
  script on disk that nothing invokes is inert; the `hooks` key is the invocation.

### 5.4 PERMISSION-WIDENING — the same treatment, listed separately so it looks like what it is

Not commands. They remove the gate in front of commands, which is the same outcome one step
removed — and it is listed as its own class precisely so the operator sees that a
`permissions.allow` of `Bash(*)` is the same decision as approving a hook, rather than
something that reads like a settings preference.

`permissions.additionalDirectories` is the one to call out by name: it grants the agent file
access **outside the workspace**, and the panel's entire containment story
([`FILES.md`](./FILES.md) §1) is that one project is one directory. An
`additionalDirectories` of `/data` is a request for the database, the audit log and every
project's `claude-home`. It gets its own sentence on the review screen rather than a row in a
list.

`permissions.deny` is worth a note in the other direction: a *narrowing* rule is safe to
adopt but is still reported, because a `deny` on the tool the operator needs is a project that
does not work for a reason they will not find.

### 5.5 CREDENTIAL — quarantined, and half-finished projects are full of these

Never written into the workspace, never displayed, never logged, never in an audit row's
metadata. The operator is told **which file held one and what shape it was**, and is offered
the panel's own credential store instead — which is [`PORTABILITY.md`](./PORTABILITY.md)'s
rule that credentials live only in `claude-home`, arriving as a concrete prompt at the one
moment it matters instead of as a paragraph in a design document.

- Detection reuses the credential-shape patterns in `plugins/logger-redaction.ts`. The same
  patterns, not a second copy: a pattern set that exists twice is one that will disagree with
  itself, and the audit metadata validator already **throws** on anything matching them, so a
  second set would mean a value the scanner called safe and the audit layer refused.
- `.env` and friends are **not deleted from the workspace**. They are the operator's own files
  and a project without its `.env` is often a project that does not run. They are *reported*,
  with a count of credential-shaped values per file, and the report says plainly that the file
  is inside the git repository and can be committed.
- **The report itself must not become the leak.** Path, key name and a character count —
  exactly the rule `npm run preflight` follows, and for the same reason: a length catches a
  truncated paste and reveals nothing.
- **`.claude/.credentials.json` is the one that is deleted**, and the asymmetry is
  deliberate: unlike `.env`, it is not the operator's own file. It is a Claude Code session
  credential belonging to whoever built the project, on a machine that is not this one, and
  keeping it would put another person's live credential on this volume.

### 5.6 UNKNOWN — default-deny, because the alternative fails in the dangerous direction

A key the classifier does not recognise is **stripped and reported**, with its value shown as
JSON.

The two directions are not symmetric. Keeping unknown keys means the next Claude Code release
can add an executable key and the panel adopts it silently, against a classifier that was
correct when it was written. Stripping them means a harmless new key is lost and the project
behaves slightly differently — visibly, in a report, with one click to approve.

The known-key list is verified against the settings reference at the time the milestone is
built, and it will be stale afterwards. The default is what makes staleness safe.

---

## 6. Git: the history is kept and hook execution is neutralised

**Decided by the operator: the history is kept. Hook execution is neutralised.** The outcome
is fixed; the mechanism is chosen here.

An uploaded `.git` directory is executable content, and on the archive path it arrives
verbatim:

- `.git/hooks/*` run on ordinary git operations — `pre-commit`, `post-checkout`,
  `post-merge`, `pre-push`. The agent will run git in that workspace on its first turn, so
  this is not hypothetical.
- `.git/config` can name commands through **aliases** (`[alias] st = !sh -c '…'`) and through
  several `core.*` keys — `core.pager`, `core.editor`, `core.sshCommand`, `core.hooksPath`,
  `core.fsmonitor`, `credential.helper`, `diff.*.textconv`, `filter.*.clean`/`.smudge`.

### 6.1 The mechanism: repoint `core.hooksPath`, and delete nothing

**Chosen: `core.hooksPath` pointed at an empty, panel-owned directory outside the
workspace** — `<claude-home>/empty-hooks/`, mode `0500`, containing nothing.

Against deleting `.git/hooks` outright:

- **It does not destroy the operator's own work.** The common case for R8 is the operator
  importing *their own* half-finished project, and their `pre-commit` hook running their
  linter is a thing they wrote and want. Deletion is irreversible and silent-in-effect; the
  hook simply stops running one day.
- **It is visible.** `git config core.hooksPath` answers, and the review screen can show the
  before and after. A deleted directory shows as nothing, and "nothing" is indistinguishable
  from "there were never any hooks".
- **It is reversible by the operator and only by the operator**, which is the right party.

The honest objection to `hooksPath` is that a config write can be undone by a later config
write — and the answer is that this is true of deletion too, since a later `git clone` or a
`cp` restores a hooks directory just as easily. Neither mechanism is a boundary. What makes
either one adequate is that it is applied to a tree that has already been scanned and reported.

### 6.2 What a determined stranger can still do afterwards

Stated rather than left implied, because a mitigation whose limits are unwritten gets trusted
past them:

- **The agent can undo it.** Anything the panel writes into `.git/config`, an agent with a
  shell in that workspace can rewrite — including on the instruction of a `CLAUDE.md` in the
  same tree, which is the INSTRUCTION class the panel deliberately does not read. This is the
  real residual and it is not closable by configuration: the agent has a shell by design.
- A **git alias** or a `textconv` filter added *after* import runs a command; §6.3's
  sanitisation is a point-in-time pass, not a lock.
- A **`.gitattributes`** in the tree can name a `filter` driver whose definition arrives later.
- The workspace's own build tooling — `package.json` `scripts`, a `Makefile`, a `justfile` —
  runs commands, and R8 does not touch any of it. **This is the boundary of the whole
  feature**: an agent asked to build the project runs the project's build. The panel's job is
  to make sure nothing runs *before* the operator has looked, not to make an untrusted
  project safe to develop in.

### 6.3 The ordering, which is easy to get wrong

**On the archive path, `.git/config` is itself untrusted, so it is sanitised of
command-bearing keys BEFORE anything is written into it.** Writing `core.hooksPath` into a
file that still contains an alias that runs a command accomplishes nothing at all — the
config was the problem and the write treated it as the destination.

In order, in staging, before promotion:

1. read `.git/config` as text and **parse it without git** — a `git config --file` invocation
   is a git process reading an untrusted config, which is the thing being avoided;
2. remove every `[alias]` section, every `core.*` key in the command-bearing list, every
   `credential.*`, every `filter.*` and `diff.*` driver, and every `[remote] proxy`;
3. **report each removal** with its key and value verbatim — these are the most interesting
   lines in the archive and they are exactly what a reviewer wants to see;
4. *then* write `core.hooksPath`;
5. leave `[remote "origin"] url` in place — it is how the operator re-pushes their own work —
   but refuse a userinfo-bearing URL the way §4.1 does, and report the remote.

On the clone path steps 1–3 are unnecessary because git wrote the config itself, and step 4 is
still applied — cheap, uniform, and it means the promoted tree looks the same whichever path it
arrived by. A per-path difference in the *result* would be a second place for the two to
diverge.

---

## 7. Detection is a report, not a boolean

"Built with Claude Code" resolves to a **list of artefacts found, with paths** — never a
yes/no that silently selects a branch. A boolean would decide the shape of the import from
evidence the operator never sees, and the two branches would differ in ways nobody could
predict from the outside.

| Signal | Strength | What it actually tells you |
| :--- | :--- | :--- |
| `.claude/settings.json` | **strong** | the project carries configuration that outranks the panel's |
| `.claude/settings.local.json` | **strong** | the same, and higher still. Usually gitignored, so it arrives by archive and not by clone |
| `.claude/hooks/`, `.claude/commands/`, `.claude/agents/`, `.claude/skills/` | **strong** | directories with no other plausible owner |
| `.claude/.credentials.json` | **strong** | somebody's live session credential, from another machine |
| `.mcp.json` at the project root | medium | Claude Code's file, but `mcp.json` is a convention several tools share |
| `CLAUDE.md` at the root, or nested | medium | conventionally Claude Code's, and now read by other agents too. Plain markdown anyone can add |
| `.claude/projects/`, `.claude/todos/`, `.claude/shell-snapshots/`, `.claude/statsig/` | weak as detection, **loud as a finding** | these are *user-level* artefacts. Their presence means somebody's `~/.claude` was copied into a project directory, which usually means the archive carries conversation transcripts |
| `Co-Authored-By: Claude` in git history | **weak** | evidence the tool was used, not that any configuration exists |
| `.claude` in `.gitignore` | **weak, and informative** | the settings were deliberately kept out of the repository — so an *archive* may carry them where a *clone* would not. This is the single best reason the two arrival paths cannot share a report |
| a CI workflow invoking `claude` | **weak** | tells you about their pipeline, not about this tree |

### 7.1 "Not detected" is a third state and must look like one

Nothing found means **nothing was found in this tree**. It does not mean the project has no
configuration: a project can be built entirely from a user-level `~/.claude/settings.json`
that never entered the repository, which is the normal case for anyone who has not committed
their settings. The report says so, in those words, rather than showing an empty list that
reads as reassurance.

So three states, visibly different:

- *"Claude Code configuration found: 4 artefacts"* → the review screen, with the classes;
- *"No Claude Code artefacts found in this archive."* followed by *"That does not mean the
  project has none — settings that were never committed do not travel in a repository. The
  panel will use its own configuration for this project."*;
- *"Scan incomplete"* — the archive was rejected before the scan finished. Not an empty list.

---

## 8. Caps, and the `node_modules` problem

A half-finished project carries a dependency directory that is routinely larger than
everything else combined and is **tens of thousands of entries**. The entry count matters as
much as the bytes: 100 000 files at 4 KB each is 400 MB and forty times the syscalls of one
400 MB file, and it is the count that makes an import feel broken.

**The default exclusion set is [`PORTABILITY.md`](./PORTABILITY.md) §6's, unchanged and from
the same constant in the same file:**

```
node_modules  .venv  venv  __pycache__  .mypy_cache  .pytest_cache  .ruff_cache
target  build  dist  out  .next  .nuxt  .svelte-kit  .turbo  .cache  .parcel-cache
vendor  Pods  .gradle  .terraform  coverage  .nyc_output  .DS_Store  *.log
```

Matched on directory name at any depth, applied **before** the entry-count and byte budgets so
the numbers the operator is shown are the numbers that will be written, shown in the import
dialog with a count of what it excluded, and **overridable** — per import, not per entry.

Everything in that set is either reinstallable from a lockfile or regenerable from source.
That sentence is doing real work and it has one R8-specific hole:

**An export's exclusion set is applied to a project the panel already has; an import's is
applied to a project it is about to become.** If `node_modules` is excluded and there is no
lockfile, the project may not build, and the operator will find out at the first turn from an
error about a missing module. So the report states, per ecosystem, whether a lockfile arrived:
*"node_modules excluded (31 402 entries, 486 MB) — `package-lock.json` found, so
`npm ci` restores it"*, or *"…— no lockfile found. Reinstalling will not reproduce the same
versions."* One clause, and it is the difference between an exclusion and a surprise.

`.git` is **not** in the exclusion set for R8. The history is kept
([§6](#6-git-the-history-is-kept-and-hook-execution-is-neutralised)), which is the opposite of
the export's default for a project that has a remote — and the reason is the opposite too: an
export can rely on the remote still existing, and an import of an unfinished project is
usually the only copy.

### 8.1 The dry run

`POST /api/projects/import/dry-run` stages, scans, classifies and stops. It writes nothing
outside staging, and staging is swept whether the operator proceeds or not. What it shows:

- the detection report ([§7](#7-detection-is-a-report-not-a-boolean));
- the classification, per class, with every EXECUTABLE and PERMISSION-WIDENING item's exact
  content;
- every CREDENTIAL finding as *file plus key plus length*;
- the git findings: hooks present, config keys that would be removed with their values, the
  remote, the branch, and the submodules that will not be fetched;
- entry count and bytes, before and after exclusions, and the volume's free space;
- the slug it would use, and the rename if that slug is taken
  ([`PORTABILITY.md` §4.3](./PORTABILITY.md#43-what-import-does-when-the-uuid-already-exists--and-when-the-slug-does));
- and, for a ZIP, the entries that **claimed** an execute bit, since §3.2 drops it.

Apply takes the **fingerprint the dry run returned** — the SHA-256 of the staged tree's
manifest — so "apply" always means "apply the thing I was just shown". A staging tree that
changed between the two is a refusal and not a surprise. This is
[`PORTABILITY.md` §7.6](./PORTABILITY.md#76-the-dry-run)'s rule, and R8 needs it more, because
here the thing being approved is a list of commands.

---

## 9. What the workspace ends up containing

Per class, concretely, because "the policy differs per class" is not a specification.

| Path | After import |
| :--- | :--- |
| `workspace/.claude/settings.json` | **rewritten** to hold only approved keys |
| `workspace/.claude/settings.local.json` | **rewritten** the same way. It ranks *above* `settings.json`, so leaving it alone would make the rewrite pointless |
| `workspace/.mcp.json` | **removed** unless a server in it was approved; a separate file at the project root, so a design that only handled `.claude/` would have a hole exactly where the executable class lives |
| `workspace/.claude/hooks/*` | left in place, never made executable, referenced by nothing until approved |
| `workspace/CLAUDE.md` and friends | untouched |
| `workspace/.env*` | untouched, reported |
| `workspace/.git/` | history intact, config sanitised, `core.hooksPath` repointed |
| `workspace/.claude/.credentials.json` | **deleted** — see [§5.5](#55-credential--quarantined-and-half-finished-projects-are-full-of-these) |
| `claude-home/imported/settings.json.original` | the original, **scrubbed**, for the diff |
| `claude-home/empty-hooks/` | empty, mode `0500`, what `core.hooksPath` points at |

### 9.1 The preserved original, and the one place I depart from the recommendation

The recommendation was to rewrite `.claude/settings.json` and preserve the original **beside
it** under a name Claude Code does not read. Agreed on rewriting; the original goes
**outside the workspace**, in `claude-home/imported/`, for four reasons that all point the
same way:

1. it is certainly not read by Claude Code, whereas "a name Claude Code does not read
   *today*" is a bet on a file-discovery rule in someone else's product;
2. it is outside [`FILES.md`](./FILES.md) §1's browser root, so it cannot be edited back into
   effect by accident;
3. it is outside the operator's git repository, so it cannot be committed and pushed;
4. `claude-home` is already the directory whose whole purpose is "panel-owned, not the
   operator's tree".

The review screen shows the diff by reading it from there — the panel serves it, read-only,
the way it will serve any other panel-owned document.

**And it is scrubbed, which is not a detail.** If the original is preserved verbatim it is a
plaintext credential file on the volume, created by the panel, in the one operation whose
entire premise is that the archive is untrusted. So credential-shaped values are replaced with
a marker that names what was there and how long it was:

```json
{ "env": { "ANTHROPIC_AUTH_TOKEN": "<quarantined: 51 characters>" } }
```

The value itself is never written anywhere outside staging, and staging is swept. If the
operator decides later that they wanted it, the answer is their own archive on their own
machine — the panel declining to become a place credentials live is the point, not a gap.

### 9.2 Two costs of rewriting, stated because they will be noticed

- **The working tree becomes dirty.** `git status` shows `.claude/settings.json` modified, and
  a later `git pull` may conflict on it. The import report says so, names the file, and points
  at the preserved original. The alternative — writing a `settings.local.json` that overrides
  the file rather than editing it — was rejected because overriding cannot *remove* a key: it
  would rely on an empty `hooks` object disabling hooks, and "probably disables it" is not a
  security control.
- **Deleting `.claude/` outright** was also rejected, and not because it is drastic: it makes
  the tree dirty in exactly the same way while destroying content the operator may want, and
  R8's requirement is to *use* the project's configuration rather than to erase it.

---

## 10. What M2.2 must reserve now

**This is why R8 is designed before M2.2 rather than at M5.** The `projects` table is
migration `012` — M2.1 took `011` for `users.locale` and the watchdog's clear-window columns,
and a migration number is claimed by the commit that lands rather than reserved by a design —
and it persists across every later change. M1.7 flagged exactly this hazard
with a numeric `projectId` in a table that outlives the decision, and the fix was to decide
before the table existed rather than to ALTER live operator data afterwards.

The distinction that matters: **a column on `projects` is expensive to add later; a whole new
table is not.** A later `ALTER TABLE projects ADD COLUMN` runs against a live volume with the
operator's projects in it, and a `NOT NULL` column added then has to invent a value for every
existing row — which is how a provenance field ends up meaning "created here, probably". A new
table added later is just a new table.

So: **the provenance and review columns land in `012` with M2.2. The per-item approval table
lands with R8's own migration.**

### 10.1 Columns migration 012 must carry

| Column | Type | Why it cannot wait |
| :--- | :--- | :--- |
| `origin` | `TEXT NOT NULL CHECK (origin IN ('created','imported_archive','cloned','imported_export'))` | how the project came to exist. No default that hides it: a column added later would have to guess, and every pre-existing row would claim to have been created here |
| `origin_ref` | `TEXT` | the archive's SHA-256, or the clone URL (safe to store, because §4.1 refuses a userinfo-bearing one). Null for `created` |
| `origin_at` | `TEXT` | ISO-8601, via `isoFrom` and never `datetime('now')` — the M2.4 note about the unmarked SQLite format applies |
| `source_install_id` | `TEXT` | for `imported_export`, [`PORTABILITY.md` §2](./PORTABILITY.md#2-what-transfers-and-what-does-not)'s `sourceInstallId`. Not a secret, and the only way to tie two panels' logs together |
| `review_state` | `TEXT NOT NULL DEFAULT 'not_required' CHECK (review_state IN ('not_required','pending','reviewed'))` | **the load-bearing one.** A project whose uploaded artefacts have not been reviewed must be distinguishable from one that has, permanently, and the projects list must be able to show it. A panel-created project is `not_required` — which is a different fact from `reviewed` and must not be spelled the same |
| `reviewed_at` | `TEXT` | when, so a review from before the last import is visibly stale |
| `artefacts_json` | `TEXT` | the detection report **as it was at import**: paths, classes, counts. Never file contents. A column and not a re-scan, because the tree changes the moment an agent touches it, and "what arrived" is a historical fact the panel is not allowed to lose |

`review_state` is the one to defend, since it is the one that looks like UI state. It is not:
it is the answer to *"has anybody looked at what this project will do?"*, it is false by
default for anything imported, and it is the flag the projects list, the spawn confirmation
and the export dialog all read. A project that is `pending` and running is a legitimate state
— the operator may proceed — but it must never be an invisible one.

### 10.2 What R8's own migration adds

A `project_import_items` table: the project's UUID, the class, the path or settings key, the
item's SHA-256, the decision (`approved` / `stripped`), when, and the raw value for
EXECUTABLE and PERMISSION-WIDENING items so the approval record says *what* was approved
rather than *that something was*. One row per decision, never updated — an append-only shape,
for the same reason the audit log has one: "this command was approved on the 3rd" is a fact,
and a later reversal is a second fact rather than an edit to the first.

Per-item state cannot live on `projects` (it is one-to-many) and does not need to exist before
R8 (adding a table is free), which is exactly why it is on this side of the line.

---

## 11. What the settings model must accommodate

M2.4's model is three hand-edited documents plus one generated artefact, and it was designed
around sources **the panel owns**. R8 introduces a source it does not: a file inside the
workspace, higher-precedence than the panel's own, possibly written by a stranger.

Most of what is needed is already there — M2.4 already says the panel must compute the
effective merge and *warn by name when a workspace file shadows a key the panel set*. Four
things are missing, and the last one is a contradiction rather than a gap.

### 11.1 `.claude/settings.local.json` is not in M2.4's model at all

It ranks **above** `.claude/settings.json`. So the effective merge reads *two* workspace files,
the shadowing warning has to name which of the two won, and the rewrite in
[§9](#9-what-the-workspace-ends-up-containing) has to cover both. A model that handled one
would produce a merge view that is confidently wrong whenever the other exists — and
`settings.local.json` is usually gitignored, so it is the file that arrives by archive and
never by clone.

### 11.2 `.mcp.json` is a separate file, and the model has no room for it

It is at the project root, not under `.claude/`, and it is not part of `settings.json`. So
M2.4's "effective settings" view has a hole **exactly where the executable class lives**.
Either the view covers it as a source of its own, or the panel's settings screen shows a
complete picture that omits the servers Claude Code will start.

### 11.3 Provenance needs a fourth *source*, not a modifier

M2.4 gives per-key provenance as `global` / `project` / `panel` / *shadowed by
`workspace/.claude/settings.json`*. The last is written as a modifier, and it cannot be: a key
that exists **only** in the workspace file has no panel-side provenance at all, and rendering
it as "not set" is precisely the failure mode — the screen would say the panel sets no
`model` while the agent uses one.

So the provenance enum becomes a source — `global | project | panel | workspace |
workspace_local | mcp_json` — plus a separate `shadows: [...]` list naming what it beat. Cheap
now; a change to every row of every settings screen later. **This is the single most expensive
thing to discover after M2.4 is built**, which is why it is in this document and not in R8's.

### 11.4 `hooks.Stop` — M2.4 claims something that is not true

M2.4 says:

> `hooks.Stop` is panel-owned and is written last, overwriting whatever either document said —
> the operator cannot break the turn-complete notification by hand.

**That is false in the presence of a workspace `.claude/settings.json` carrying a `hooks.Stop`.**
"Written last" is about the order in which the panel merges its *own* two documents into the
generated file. The generated file is the **user-level** file — level 5, the lowest — and the
workspace file is level 4 or 3. So a project whose archive contains a `hooks.Stop` silently
replaces the panel's, and the turn-complete notification never fires: the feature looks
configured, the queue stays empty, and the M2.5 dead-channel banner correctly reports a healthy
channel with nothing in it.

Three ways out, and the third is the one to take:

1. **Warn by name.** Necessary regardless, and the wording has to include the consequence, not
   just the fact: *"`hooks.Stop` is set by `workspace/.claude/settings.json` and overrides the
   panel's. Turn-complete notifications will not fire for this project."* A warning that says
   only "shadowed" is one nobody acts on.
2. **Strip it**, which R8's EXECUTABLE default already does — so an R8 import is safe by
   accident. It does nothing for a project the operator creates in the panel and then adds a
   `.claude/settings.json` to by hand, which is a normal thing to do and the more likely case
   in the long run.
3. **Pass the panel's non-negotiable keys with `claude --settings <file>`**, which is level 2
   and outranks both workspace files. Then the panel's Stop hook cannot be displaced by
   anything in the tree, and M2.4's claim becomes true instead of aspirational. The user-level
   file keeps carrying the operator's own defaults, where being overridable is correct.

**Recommendation: (3), with (1) as well, and (2) is already the R8 default.** The cost is one
argument at spawn and a second generated file, and the payoff is that the one key the panel
genuinely owns stops depending on the contents of a directory anybody can write.

**Answered on 2026-09-05: it layers.** The question this section left open — whether
`--settings` merges with the lower levels or replaces them — was resolved against the current
settings documentation and the surrounding issue history, because M2.4's generator depends on
it. **The chain is a merge, not a selection:** for a scalar key the highest-precedence file
that defines it supplies the value, **arrays are concatenated and de-duplicated across
scopes**, and objects are deep-merged. The documented exceptions that do *not* merge are
`fallbackModel`, `availableModels`, `modelPicker`, `modelSettings` and `claudeMdExcludes`.
Permission rules merge, with `deny` beating `ask` beating `allow`.

So recommendation (3) is safe in the direction that was worrying: **passing `--settings` does
not discard the operator's own user-level settings**, and the panel *can* outrank a workspace
file for any scalar and for any individual key of a deep-merged object — including
`env.ANTHROPIC_BASE_URL` and `env.ANTHROPIC_AUTH_TOKEN`.

**And it is the reason the EXECUTABLE class exists.** `hooks` is array-valued, so an uploaded
`hooks.Stop` is *concatenated* with the panel's rather than outranked by it — **it still
runs**. `mcpServers` is deep-merged, so an uploaded server is *added*, not replaced.
`permissions.allow` merges. **Every key in the executable and permission-widening classes of
[§5.3](#53-executable--stripped-by-default-and-this-is-the-whole-security-argument) and
[§5.4](#54-permission-widening--the-same-treatment-listed-separately-so-it-looks-like-what-it-is)
is a key that merges**, which is why stripping them is mandatory and why no amount of
precedence can substitute for it. There is a public issue whose title is a user complaining
that the settings flag merges instead of overriding hooks configuration; that is the
behaviour.

One consequence for `hooks.Stop` specifically, and it *softens* the failure above: because
hooks concatenate, a workspace `hooks.Stop` cannot remove the panel's — both fire, and the
turn-complete notification survives a hostile workspace file. What it does not survive is the
panel not passing `--settings` at all.

**Merge semantics are a property of a release, and must never carry a security property.** The
exception list and the same-name rules changed at named versions (v2.1.175, v2.1.228,
v2.1.242). Rely on the merge for convenience; never as the reason a class is safe. This is the
same rule as [§1.1](#11-one-refinement-because-the-reframe-is-not-quite-unconditional)'s: folder
trust must not be why something is treated as inert.

**The empirical check stays a requirement on M2.4**, narrowed to what is worth confirming
rather than what is now known: run the generator against a temporary config dir with a
deliberately conflicting `hooks.Stop` in a scratch workspace, confirm **both** hooks fire, and
**record the observed behaviour and the Claude Code version beside the claim** — because the
version is what the claim is true of.

---

## 12. Audit and notification

New audit events. Every one needs a rule or an explicit `null` in `notification-rules.ts`,
which is exhaustive over `AuditEvent` and will not compile without one.

| Event | Notified | Why |
| :--- | :--- | :--- |
| `import.staged` | no | implied by whatever happens next, and a staged tree that is then rejected or abandoned is not news |
| `import.scanned` | no | the operator is looking at the screen it produced |
| `import.rejected` | no | malformed, oversized, too many entries, a clone that failed or timed out. The operator is watching, and a rejected upload is usually their own mistake |
| `import.blocked` | **yes**, unthrottled | an entry or a URL that was *actively unsafe*: a path that tried to escape, a duplicate entry, an `ext::` URL, a userinfo-bearing clone URL. Somebody handed the operator a file that tried something, and that is worth a message whether or not they are at the screen |
| `import.credential_quarantined` | **yes**, throttled | a credential arrived in an uploaded file. Throttled because a project with twelve `.env` files is one message and a count, not twelve |
| `import.executable_approved` | **yes**, unthrottled | see below |
| `import.git_neutralised` | no | implied by `import.applied`, which is notified. The row exists because the *values removed from `.git/config`* are evidence, and evidence belongs in the append-only log |
| `import.applied` | **yes** | already specified for the export path in [`PORTABILITY.md` §11](./PORTABILITY.md#11-endpoints) and already flagged there as among the most valuable alerts the panel can send. R8 reuses it and adds its origin kinds to the meta |

`import.rejected` and `import.blocked` are two events rather than one with a category, because
`AlertRule` is keyed per event and cannot branch on metadata. Splitting them is what lets a
malformed zip be silent and an escape attempt be loud, which is the distinction that matters.

**`import.executable_approved` is the most security-relevant event this panel can produce.**
Not the credential quarantine, which is close behind: quarantine is the panel *declining* to
do something dangerous, and this is the panel being *authorised* to run a command line from a
downloaded archive inside the container that holds `PANEL_MASTER_KEY`, every stored credential
and the audit chain's HMAC subkey. It is a privilege grant, so:

- **step-up gated** — password plus a fresh code, the same bar as revealing a secret, because
  the outcome is at least as bad;
- notified, unthrottled, with the command in the message. If the operator did not just do
  this, it is a total compromise and the command is the first thing they need to see;
- and the command string is metadata going into the audit log, so it passes through
  `AuditService`'s validator like everything else — which **throws** on anything
  credential-shaped. An `apiKeyHelper` of `echo sk-ant-…` therefore fails the write loudly
  rather than laundering a credential into an append-only log. That is the validator working,
  and the approval must fail with it rather than around it.

Two events deliberately absent: nothing is written when an item is *stripped* (that is the
default, and a default that audits is a log full of the ordinary case), and nothing records
that the operator *read* the report — reads are not audited anywhere in this panel
([`FILES.md`](./FILES.md) §7) and this is not the place to start.

---

## 13. Placement, and what has to land earlier

**R8 is M2.8.** Nothing existing is renumbered.

| Depends on | For |
| :--- | :--- |
| **M2.2** | the projects table, the UUID, `/data/projects/<uuid>/`, **and §10's columns** |
| **M2.3** | `utils/contain-path.ts`. Reusing it is mandatory |
| **M2.4** | the settings model, **including §11's four changes**, and the credential store the quarantine prompt offers |
| **M2.6** | the staging-and-swap pipeline, the `incoming/` sweep, the caps, the dry-run/fingerprint shape |
| the image | `git` in the runtime stage ([§4.6](#46-git-is-not-in-the-image)), which Phase 3 needs anyway |

After M2.6 rather than beside it, for one reason: M2.6 builds the pipeline and R8 adds a second
arrival path to it. Building both at once is how the "one scanner, one promoter" rule in
[§2](#2-two-arrival-paths-one-pipeline) gets negotiated away under schedule pressure.

### 13.1 What can land earlier, because it is only a decision

- **§10's columns must land with M2.2.** Not "should" — this is the whole reason R8 is designed
  now, and a column added afterwards is an ALTER against live operator data.
- **§11's four settings-model changes must land with M2.4**, and §11.4's `--settings`
  verification before its generator is written.
- **`git` in the image** can land with either M2.8 or Phase 3, whichever is first.
- **The classifier's key table** — the six classes and the known-key list — is a constant file
  with no consumers and could land any time. There is no value in landing it early, and one
  cost: a key list with nothing exercising it is a list that is wrong by the time it is used.
  Land it with the scanner.
- **The ZIP reader dependency** ([§3.3](#33-the-reader-must-not-be-the-writer)) is chosen
  before M2.8 starts, after `npm audit --omit=dev`, and recorded in
  [`CLAUDE.md`](../CLAUDE.md)'s pinned-versions table with its reason like every other one.

---

## 14. Tests to write, and files

Beyond the adversarial table in [`FILES.md`](./FILES.md) §2, which this reuses wholesale:

- a ZIP with a symlink entry in its external attributes → a **regular file containing the link
  text**, asserted by `lstat`, not by an error;
- a ZIP with two entries for one path → refused, and **nothing written**;
- a ZIP whose local header and central directory disagree → refused;
- a ZIP with a single common root directory → stripped once, and a ZIP with two top-level
  directories → not stripped;
- a `.git/config` carrying an alias, a `core.pager` and a `credential.helper` → all three
  reported with their values and absent from the promoted tree, and `core.hooksPath` written
  **after** they were removed (assert the order by asserting the result of doing it wrongly:
  a config still containing an alias is a failing case);
- a clone URL of `ext::sh -c id` → refused before any subprocess starts, asserted by there
  being no child process rather than by the error string;
- a clone URL with userinfo → refused, and the message names the credential store;
- a clone against a local bare repository with `core.symlinks=false` → the symlink is a plain
  file (this is the one clone test that needs no network);
- a repository with a `.gitmodules` → cloned without recursion, submodules listed in the
  report, the directories empty;
- a settings file with one key of each class → INERT lifted, INSTRUCTION kept and counted,
  EXECUTABLE and PERMISSION-WIDENING absent from the promoted file and present in the report
  with their exact values, CREDENTIAL absent everywhere and reported as file-plus-length;
- an unknown key → stripped and reported, which is the test that pins the default-deny;
- the preserved original → present in `claude-home`, credential values replaced by the marker,
  and the **sentinel sweep extended**: a credential in an uploaded archive appears in **no**
  file on the volume and in no database file, with the allowlist asserted non-vacuous exactly
  as the base-path exemption already is;
- the static scan of [§2.1](#21-what-enforces-that-they-cannot-diverge-later): one promoter
  call site, two arrival modules that import neither the promoter nor the classifier;
- and an apply against a stale fingerprint → refused.

Files, when it is built: `src/server/services/import-pipeline.ts` (stage, scan, promote),
`src/server/services/claude-artefacts.ts` (detection and the class table),
`src/server/services/git-sanitise.ts`, `src/server/services/zip-reader.ts`,
`src/server/routes/import.ts`, `tests/unit/claude-artefacts.test.ts`,
`tests/unit/git-sanitise.test.ts`, `tests/unit/zip-reader.test.ts`,
`tests/integration/import.test.ts`, `tests/integration/import-adversarial.test.ts`.
