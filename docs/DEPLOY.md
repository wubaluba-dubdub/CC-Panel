# Deploying the panel to Railway

Written for someone who has not deployed anything before. Follow it in order; every step
says what it does and what happens if you get it wrong.

Read the whole of **[Before you start](#before-you-start)** first. Two of the values you
are about to create cannot be recovered if you lose them, and one of them cannot be
rotated at all.

---

## Before you start

You need:

- a **GitHub account** (the repository must be **private** — see below);
- a **Railway account** with a plan that allows a persistent Volume;
- `git` and `node` (22 or newer) on your own machine;
- a **password manager**, or somewhere else you trust to keep two secrets permanently.

Three things about this panel that shape everything below:

1. **It stores its whole state in one SQLite file on one volume.** There is no external
   database. That makes it cheap and makes backups a single file — and it means the
   service runs as exactly **one replica**, because two replicas would be two writers on
   one file. `railway.json` pins `numReplicas: 1`; do not raise it.
2. **`PANEL_MASTER_KEY` is permanent.** Every stored secret is encrypted under a key
   derived from it, and every audit-log row is signed with another. There is no rotation
   procedure. Losing it means losing the encrypted secrets and the ability to verify the
   audit log; changing it means the same thing. Put it in a password manager before you
   use it. See [Key rotation](./SECURITY.md#key-rotation).
3. **The panel is reached at a secret URL prefix**, generated on first boot and printed
   **once**. It is obscurity, not a security boundary — authentication is the boundary —
   but you still need it to reach the panel at all, so copy it when you see it.

### The repository must be private

Not because the code is secret, but because this repository is what Railway builds, and
a public one invites anyone to read the panel's exact security model, the base-path
generation, and the layout of the volume. None of that is a vulnerability on its own. It
is also free to withhold.

**Never commit `.env`.** `.gitignore` excludes it and `.dockerignore` keeps it out of the
image; `scripts/verify-image.sh` checks the built image for one anyway, because a
`.dockerignore` pattern that stops matching is silent.

---

## 1. Generate the master key

On your own machine:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

That prints 44 characters. **Put it in your password manager now**, labelled
`PANEL_MASTER_KEY` for this deployment. You will paste it into Railway in step 5 and you
should never need it again — but if the volume is ever lost and restored from a backup,
this is the only thing that makes that backup readable.

Also decide your admin password now. It must be at least 12 characters and must not be on
the weak list in `src/server/utils/weak-passwords.ts`. Put it in the password manager too.

---

## 2. Check the configuration before you deploy anything

```bash
npm ci
npm run preflight
```

`preflight` validates the whole configuration and prints a pass/fail line per fact. Run it
now against your local `.env`, and run it again after **every** change to a Railway
variable. It exits non-zero if anything failed, so it can sit in front of a deploy.

It prints **no secret values** — for each credential it prints only whether it is set and
how many characters it has, which is enough to catch the two mistakes that actually
happen (a variable that never arrived, and a value truncated by a paste). The base path is
treated as a secret too, so it is never printed.

To run it against the deployed service later, use Railway's shell:

```bash
node dist/server/cli/preflight.js
```

---

## 3. Create the private repository and push

```bash
cd /path/to/cc-panel
git status                      # should be clean
gh repo create cc-panel --private --source=. --push
```

Without the `gh` CLI: create an empty **private** repository on github.com, then

```bash
git remote add origin git@github.com:<you>/cc-panel.git
git push -u origin master
```

Nothing is deployed yet. Railway is not involved until the next step.

---

## 4. Create the Railway service from the repository

1. Railway dashboard → **New Project** → **Deploy from GitHub repo**.
2. Authorise Railway for the repository if it asks, and pick `cc-panel`.
3. Railway will detect `railway.json` and build from the `Dockerfile`. It will also start
   a first deployment **immediately, and that deployment will fail** — there are no
   variables yet, so the panel refuses to boot. That is correct behaviour, not a problem
   to fix; it will succeed once step 6 is done.

Do not add a second service. One service, one volume, one replica.

---

## 5. Attach a Volume mounted at `/data`

Service → **Settings** → **Volumes** → **New Volume**, mount path exactly:

```
/data
```

Everything that survives a redeploy lives there: `panel.db`, the generated base path in
`config/instance.json`, the process `HOME`, and later the project checkouts.

**If you get the mount path wrong**, the container filesystem is used instead. It works —
and then the next deployment silently starts from nothing: a new base path, a re-seeded
user, no audit history. The symptom is "the panel forgot everything after a deploy". Check
Settings → Volumes and confirm the mount path is `/data`, or set `PANEL_DATA_DIR` to
whatever it actually is.

---

## 6. Set the variables

Service → **Variables**. Add these, exactly.

### Required

| Variable | What it does | What happens if it is wrong |
| --- | --- | --- |
| `PANEL_MASTER_KEY` | The one root secret. Every stored credential is encrypted under an HKDF subkey of it, and every audit row is HMAC'd with another. | **Missing or under 32 bytes decoded:** refuses to boot with a message saying so. **Changed later:** stored secrets stop decrypting and `GET /api/audit/verify` reports `row_hash_mismatch` at the oldest row with `hint: wrong_key_or_genesis` on a log nobody touched. There is no rotation procedure — see [Key rotation](./SECURITY.md#key-rotation). |
| `PANEL_ADMIN_USERNAME` | Seeds the single user on first boot. Read once and never again. | **Missing with no user in the database:** refuses to boot, because a panel nobody can log into is not a recoverable state. |
| `PANEL_ADMIN_PASSWORD` | Seeds that user's argon2id hash on first boot. Minimum 12 characters, not on the weak list. | **Too short or weak:** refuses to boot. **Left set after first boot:** ignored, with a warning on every boot telling you to remove it (step 10). It is never used to overwrite the stored hash. |
| `PANEL_PUBLIC_URL` | The https origin the panel is served on, e.g. `https://cc-panel-production.up.railway.app`. Origin, no path. | The most confusing failure available — see the box below. |
| `RAILWAY_RUN_UID` | Set to `0`. Starts the container as root so the entrypoint can make the volume writable, then drops to uid 10001. | **Unset:** on a root-owned volume the entrypoint refuses to start and prints this variable's name. See step 7. |

> ### `PANEL_PUBLIC_URL` is load-bearing in three places at once
>
> It decides the session cookie's **name prefix**, the cookie's **`Secure` attribute**,
> and what `Origin` and `Host` are validated against. All three come from one resolver
> (`src/server/utils/public-origin.ts`), and a test enforces that nothing else reads the
> variable — so they cannot disagree with each other. They can all be wrong together.
>
> **A wrong value produces a login that appears to work and then fails.** The password
> step returns `200` and a `Set-Cookie` that is present and correct on the wire; the
> browser then declines to store it, because a `__Secure-` cookie must arrive over a
> secure scheme and the panel believed it was on one it is not. Nothing appears in the
> console. The next request has no session, so it is a `401`, and the panel looks like it
> is rejecting the right password.
>
> Get it right by copying the domain Railway shows under Settings → Networking, with
> `https://` in front and nothing after it. If you leave the variable unset entirely,
> Railway's own `RAILWAY_PUBLIC_DOMAIN` is used as a fallback and is always https — that
> works, and setting the variable explicitly is still better, because a custom domain
> later changes one and not the other.
>
> The resolved value is printed once at boot, at info level, in the line
> `panel configuration resolved` — along with which cookie profile it selected and the
> cookie name that follows from it. Check that line after your first deploy. It is safe to
> log; the base path is not, and is not in it.

### Optional

| Variable | Default | Notes |
| --- | --- | --- |
| `PANEL_TRUST_PROXY` | `true` | **Leave it on.** Both settings work behind Railway, which is the trap: the edge sets `Host` as well as `X-Forwarded-Host`, so "does it work?" does not distinguish them. Off, the scheme-downgrade check is silently gone (a bypassed TLS terminator becomes indistinguishable from a normal request), every session row and audit row records the container network's address instead of the client's, and `Host` becomes the only input. On is safe because only the **rightmost** forwarded value is honoured — the one the hop we are talking to wrote — and the expected origin never comes from the request. |
| `PANEL_BASE_PATH` | generated | The secret URL prefix. Leave it unset and let the panel generate 22 characters on first boot; set it only if you are deliberately pinning a value you already have. |
| `PORT` | `8080` | Railway injects this. Do not set it by hand. |
| `PANEL_DATA_DIR` | `/data` | Only if your volume is mounted somewhere else. |
| `PANEL_LISTEN_HOST` | `0.0.0.0` in the container | Do not set it. Loopback here means Railway's edge cannot reach the service while the logs still say the server is listening. |
| `NODE_ENV` | `production` | Baked into the image. Do not override it: outside production the panel accepts loopback origins and does not send HSTS. |
| `PANEL_IN_CONTAINER` | `1` | Set by the `Dockerfile`; a fact the image asserts about itself so the listen host does not have to be guessed. Never set it by hand, and never set it to anything else. |
| `PANEL_OUTBOUND_PROXY` | unset | An `http://` or `https://` proxy for the panel's **outbound** requests — today only Telegram. Leave it unset on Railway, which can reach `api.telegram.org` directly. Set it for local work from a country that cannot. It may carry `user:password@host`, so it is never printed: `preflight` reports it as set or not set, and it is elided from every log line. A malformed value is a boot failure with a clear message rather than a connection error half an hour later. |
| `PANEL_NOTIFY_INCLUDE_LINKS` | `false` | Whether a notification may end with a deep link into the panel. **Leave it off unless you have read [the consequence](#notifications-telegram).** |
| `PANEL_NOTIFY_LOCALE` | `en` | `en` or `fa`. The language notifications are written in — the one place the server holds a locale, because a Telegram message has no browser to render it. |
| `PANEL_WATCHDOG_ENABLED` | `true` | The always-on resource watcher: memory, the volume, the OOM-kill counter, and an unclean restart. **Leave it on in production.** Without it the panel can tell you about a failed login and not about the thing that actually stops it. Off is for a local machine where a nearly-full disk would queue alerts for a Telegram nobody has configured. |
| `PANEL_WATCHDOG_MEMORY_PERCENT` | `85` | The memory alert threshold, as a whole percentage of the container's `memory.max`. The alert **clears** ten points lower (75 %), and that gap is not configurable on purpose: two numbers an operator can set are two numbers that can be set the wrong way round, which is a machine that alternates between "alert" and "recovered" on every sample. A value that is not a whole number between 1 and 100 is a boot failure naming the variable — a mistyped threshold otherwise produces a panel that looks configured and never alerts. |
| `PANEL_WATCHDOG_DISK_PERCENT` | `80` | The same for the volume, clearing at 70 %. Lower than memory deliberately: recovering from a full volume means deleting something, which takes a human, and a volume with no space left stops the audit log — so the disk alert is protecting the panel's own tamper-evidence, not just the feature that filled the disk. |

---

## 7. Why `RAILWAY_RUN_UID=0` is not a security regression

This is the step that looks wrong, so here is the whole argument.

**The problem.** Railway mounts the volume when the container *starts*, not when the image
is built, and the mount is **root-owned**. Two consequences, both fatal:

- A `chown` in the `Dockerfile` is erased. The image's `/data` is replaced by the mount, so
  whatever ownership the build set is simply not there any more.
- A container that is *already* running as uid 10001 when the mount appears cannot create
  `panel.db` inside it. It fails with `EACCES` on the first write, at boot, on a deployment
  that looked fine until that moment.

So something has to run as root after the mount and before the server.

**What actually happens.** `RAILWAY_RUN_UID=0` starts the container as root. The first
thing that runs is `entrypoint.sh`, which:

1. creates `/data` and its known subdirectories if they are missing;
2. fixes their ownership to `10001:10001` — **only where it is actually wrong**, and never
   recursively, because `/data` will grow to hold project checkouts and a recursive chown
   on every boot is a startup that gets slower forever. Measured: the no-op pass is 22–30
   ms and does not change when 20 000 files are added to the volume, where `chown -R` over
   the same volume is 170 ms and scales with the file count;
3. `exec setpriv --reuid 10001 --regid 10001 --clear-groups --no-new-privs` — so the server
   replaces the shell, becomes pid 1, and receives `SIGTERM` directly from the runtime.

**The panel therefore never runs as root.** Two independent things enforce that:

- `setpriv --reuid` sets the **saved** set-user-ID as well as the real and effective ones,
  so the process cannot call `setuid(0)` and get root back. Verified in the container:
  `setuid(0)` and `seteuid(0)` both return `EPERM`, and `/proc/1/status` shows
  `Uid: 10001 10001 10001 10001` with `NoNewPrivs: 1`.
- The server asserts it at boot (`src/server/utils/privileges.ts`) rather than trusting the
  above. If it finds itself as uid 0, or finds that it *can* return to uid 0, it refuses to
  serve and says why. This matters because Phase 3 spawns agent processes as children of
  this process: a root panel would make every one of them root.

**What you would get without it.** The container starts as an unprivileged uid, cannot
write the volume, and the entrypoint refuses to start — printing `RAILWAY_RUN_UID=0` and a
pointer to this section, rather than an `EACCES` stack trace for you to decode. It refuses
rather than degrading: a panel that started and then could not persist anything is worse
than one that did not start.

---

## 8. Set the healthcheck path

`railway.json` already sets it:

```json
"deploy": { "healthcheckPath": "/healthz", "healthcheckTimeout": 120 }
```

If your service's dashboard settings override the file, set **Settings → Deploy →
Healthcheck Path** to `/healthz` there too.

**Why it matters more than it looks.** Railway polls that path until it returns `200` and
**only then** makes the new deployment live; it does not poll afterwards. So:

- a `/healthz` that fails during boot costs you a deployment and leaves the previous one
  running, which is the right outcome when the new one is broken;
- a `/healthz` that returned `200` too early would push a broken deployment live, and
  nothing would check again.

Because of that asymmetry the endpoint asserts more than reachability: it also does one
bounded read of the database and compares the applied migration count with what the build
ships. It answers exactly `{"ok":true}`, or `503` with exactly `{"ok":false}` and the
reason in the log — never in the body, because the endpoint is unauthenticated. It needs no
base path and no session, and it is exempt from `Host` validation and rate limiting, both
because a `403` or a `429` there is a way to kill the container.

The `HEALTHCHECK` in the `Dockerfile` is a *different* thing: it is for local `docker run`,
so that `docker ps` says something true. Railway ignores it and uses the configured path
above.

---

## 9. Turn off App Sleeping

Service → **Settings** → **Deploy** → **App Sleeping** (sometimes "Serverless") → **off**.

Railway's app sleeping stops the container when there is no inbound traffic and starts it
again on the next request. For a stateless web service that is free money. For this panel
it is destructive, and it gets worse as the project progresses:

- **Now:** every sleep is a restart. Sessions survive (they are rows in `panel.db`, not
  memory) but the in-memory rate-limit buckets and the progressive-delay throttles reset,
  and every wake pays argon2's dummy-hash computation before it can answer.
- **From Phase 3:** the panel runs **agent processes** — a Claude Code CLI in a pty, doing
  work that takes minutes. Those are children of the server process. Sleeping the container
  kills them mid-task, and the whole point of the panel is to start long work and walk
  away. A notification saying "your agent finished" would never arrive because the thing
  that sends it was stopped.

There is no way for the panel to defend itself against this from inside. It has to be off.

---

## 10. Deploy, and find the base path

Push, or hit **Deploy** in the dashboard, and open **Deployments → the running deployment →
Logs**. On a first boot you will see, in this order:

```
[entrypoint] ownership pass: 7 paths checked, 7 changed, 51ms
[entrypoint] dropping to uid 10001 and exec'ing the server

╔════════════════════════════════════════════════════════╗
║  Panel base path (copy this URL — you will need it):   ║
║  /MuR_8kODEMB1CtKdTEUX7Q                               ║
║                                                        ║
║  This path is persisted in /data/config/instance.json  ║
║  It will NOT be shown again. Set PANEL_BASE_PATH env    ║
║  to override.                                          ║
╚════════════════════════════════════════════════════════╝

{"level":30,...,"msg":"Seeded the single admin user. Two-factor enrolment is required before login can complete."}
{"level":30,...,"publicOrigin":"https://...","cookieProfile":"secure","sessionCookie":"__Secure-panel_session","listenHost":"0.0.0.0","msg":"panel configuration resolved"}
{"level":30,...,"msg":"Server listening at http://0.0.0.0:8080"}
```

**Copy the base path.** Your panel is at `https://<your-domain>/<that-value>/`. Put it in
the password manager next to the other two secrets.

It appears in the log **once**, on the boot that generated it, and never again — the
redacting log destination replaces it with the literal `<base>` in every other line,
because Railway retains stdout and it is readable from the dashboard forever. If you miss
it, [Rotating the base path](#rotating-the-base-path) below tells you how to get a new one.

Check the `panel configuration resolved` line while you are here:

- `publicOrigin` is the URL you actually use;
- `cookieProfile` is `secure` and `sessionCookie` starts with `__Secure-`. If it says
  `development`, `PANEL_PUBLIC_URL` is http and you are about to hit the failure described
  in step 6;
- `listenHost` is `0.0.0.0`. If it is `127.0.0.1`, Railway's edge cannot reach the service
  and every request will time out at the edge while these logs look perfect.

Confirm the healthcheck from outside:

```bash
curl -i https://<your-domain>/healthz
# HTTP/2 200 ... {"ok":true}
```

And confirm the base path is a gate — a wrong prefix must be indistinguishable from any
other miss:

```bash
curl -o /dev/null -w '%{http_code}\n' https://<your-domain>/not-the-base-path/
# 404
```

---

## 11. Log in the first time

There is no UI yet (that is M2), so the first login is four API calls. Set two shell
variables and paste the blocks in order.

```bash
PANEL=https://<your-domain>/<your-base-path>
JAR=$(mktemp)
```

**Stage one — the password.** This also gives you the CSRF cookie every later mutating call
must echo.

```bash
curl -sS -c "$JAR" -b "$JAR" -X POST "$PANEL/api/auth/login" \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<your admin password>"}'
# {"authLevel":"pre",...}
```

That is a five-minute, single-purpose session: it can reach the second-factor and enrolment
endpoints and nothing else.

**Enrol the second factor.** Mandatory — the panel will not issue a full session without
it. `CSRF` is read out of the cookie jar, which is exactly what a browser's script does.

```bash
CSRF=$(awk -F'\t' '{sub(/^#HttpOnly_/,"",$1)} NF>=7 && $6=="__Secure-panel_csrf" {print $7}' "$JAR" | tail -1)

curl -sS -c "$JAR" -b "$JAR" -X POST "$PANEL/api/auth/totp/enroll" -H "x-csrf-token: $CSRF"
# {"secret":"JBSWY3DPEHPK3PXP...","otpauthUri":"otpauth://totp/...","algorithm":"sha1","digits":6,"periodSeconds":30}
```

Add the `otpauth://` URI to your authenticator. There is no QR image in the response — the
UI that renders one is M2 work — so either paste the URI into an app that accepts one, or
enter the `secret` by hand with the `algorithm`, `digits` and `periodSeconds` the response
states. Then confirm with a code from the app; this is what actually turns two-factor on:

```bash
curl -sS -c "$JAR" -b "$JAR" -X POST "$PANEL/api/auth/totp/enroll/verify" \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"code":"123456"}'
# {"recoveryCodes":["...", ... 10 of them]}
```

**Save those ten recovery codes.** They are shown exactly once, each works once, and they
are the only way back in if you lose the authenticator. Password manager, next to the rest.

You now hold a full session. Check it:

```bash
CSRF=$(awk -F'\t' '{sub(/^#HttpOnly_/,"",$1)} NF>=7 && $6=="__Secure-panel_csrf" {print $7}' "$JAR" | tail -1)
curl -sS -c "$JAR" -b "$JAR" "$PANEL/api/auth/me"
# {"authLevel":"full",...}
```

Every later login is two steps: `POST /api/auth/login`, then `POST /api/auth/login/totp`
with a fresh code. A code is accepted once — replay protection persists the last accepted
step — so if you have just used one, wait for the next 30-second window.

---

## 12. Remove `PANEL_ADMIN_PASSWORD`

Do this as soon as the first login works.

Service → **Variables** → delete `PANEL_ADMIN_PASSWORD`, and `PANEL_ADMIN_USERNAME` with
it. Railway will redeploy.

The panel never re-seeds and never overwrites the stored hash, so leaving them set does not
create a way in — it logs a warning on every boot and ignores them. The reason to remove
them is simpler: a plaintext password does not need to outlive first boot, and a Railway
variable is visible to anyone with dashboard access, appears in the deployment's
environment, and is one screenshot away from being somewhere else.

After the redeploy, `npm run preflight` (or `node dist/server/cli/preflight.js` in Railway's
shell) should show:

```
  PASS  admin credentials: the user exists and neither variable is set, which is the state to be in after a first boot
```

To change the password afterwards, use the API — `POST /api/security/password`, which
requires a step-up (password **plus** a fresh code) and **revokes every other session**,
because the only reason to change a password is fear that it leaked.

---

## Rotating the base path

Do it if the prefix has been in a screenshot, a shared terminal, a browser history you do
not control, or if you never copied it in the first place.

**From the API** (needs a full session *and* a step-up):

```bash
curl -sS -c "$JAR" -b "$JAR" -X POST "$PANEL/api/auth/step-up" \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"password":"<your password>","code":"<fresh code>"}'

curl -sS -c "$JAR" -b "$JAR" -X POST "$PANEL/api/security/base-path/regenerate" \
  -H "x-csrf-token: $CSRF"
# {"basePath":"<the new one>","restartRequired":true}
```

Two things about that response.

`restartRequired: true` is not advisory. The prefix is resolved once at boot and the routes
are mounted under it, so **the running process keeps serving the old path** until it
restarts. Redeploy or restart the service, then use the new value.

And it is the only time the new value is returned. Copy it before you close the terminal —
and remember that it is now in your shell history, so clear that if the terminal is not
yours alone.

If `PANEL_BASE_PATH` is set in the environment this route answers `409` and says so, rather
than regenerating a value the environment would override on the next boot. Change the
variable instead.

**From Railway, if you cannot log in at all:** set `PANEL_BASE_PATH` to a value you choose
(22+ characters, URL-safe: `A–Z a–z 0–9 - _`) and redeploy. The environment variable wins
over the persisted value, so this works without any access to the panel. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('base64url').slice(0,22))"
```

The session cookie is scoped to `Path=/<basePath>`, so rotating it makes every existing
cookie unattachable — which is a logout for every session, including yours. That is the
correct behaviour and worth knowing before you do it mid-task.

---

## Notifications (Telegram)

Optional, and off until you configure it. The panel queues an event, a single worker
delivers it, and **nothing in a request path ever waits on Telegram** — so a wrong token
or a blocked network slows nothing down and loses nothing: the queue keeps the events and
drains when the configuration works.

### 1. Make a bot and find your chat id

1. In Telegram, message **@BotFather**, send `/newbot`, and follow it. You get a token
   that looks like `123456789:AA...` — that is a **credential**, and it stops working the
   moment you press `/revoke`.
2. Find your new bot and **press Start**. This step is not optional and is the one people
   miss: *a bot cannot message someone who has not messaged it first.*
3. Store the token, then ask the panel to find the chat:

```bash
node dist/server/cli/telegram-set.js         # prompts for the token, then the chat id
node dist/server/cli/telegram-discover.js    # lists the chats that have messaged the bot
```

`telegram-set` reads each value from a **prompt or a pipe, never from the command line** —
an argument would be in your shell history and in the process list. Run it with only the
token first, take the chat id from `telegram-discover`, then run it again to store that.

Locally, the same three commands are `npm run telegram:set`, `npm run telegram:test` and
`npm run telegram:discover`.

### 2. Send a test message

```bash
node dist/server/cli/telegram-test.js
```

It reports **which stage** succeeded — credentials present, Telegram reachable, Telegram
accepted the token, message queued, message delivered — because those failures need
completely different fixes.

> ### A failure from your own machine is expected, and does not mean the token is wrong
>
> `api.telegram.org` is unreachable from some countries, including this operator's. From a
> local container with no proxy, `telegram-test` will report **"could not reach Telegram at
> all"** — which is a *network* result and looks nothing like "Telegram answered and
> refused us", which is what a wrong token produces. The command distinguishes them on
> purpose. Set `PANEL_OUTBOUND_PROXY` for local testing; on Railway it works without one.

### 3. What it sends, and what it never sends

- **Plain text.** No Markdown, no HTML, and that is a decision rather than a limitation: a
  single unescaped `_` or `[` in a report makes Telegram reject the whole message with
  `can't parse entities`, and a Claude Code report is made of exactly those characters.
- Above **4096 characters** the message is truncated at a character boundary with a marker
  line, and the full text follows as a `.txt` attachment. The attachment is a second
  request and is allowed to fail on its own — you keep the readable part.
- **Never a credential, and never the base path.** Every event is redacted and the base
  path elided *before the row is written*, so neither is in the queue table either, and
  the outbound body is scrubbed again on its way out.
- **The audit log records that a notification was sent, never what it said.**

### The link setting, and the one sentence that matters

`PANEL_NOTIFY_INCLUDE_LINKS=true` makes a message end with a link straight to the panel.
That link contains your **base path**.

> **Anyone who can read that chat can reach your login page.** A Telegram message is
> permanent storage that the panel does not control: it lives on Telegram's servers, syncs
> to every device you have ever signed in from, and is readable by anyone who gets at your
> phone or your account. If you turn this on and later suspect your Telegram account, treat
> the base path as disclosed and [rotate it](#rotating-the-base-path).

Off is the default. There is no middle setting, deliberately: a link without the base path
is a URL that 404s, and a short-lived signed link would be a second way into the panel that
starts from a chat message.

### Rotating the token

Like every other stored credential: `npm run telegram:set` again, or
`PUT /api/secrets` with `{"scope":"telegram","name":"bot_token"}` — which needs a
**step-up** (password plus a fresh code within five minutes), the same as writing any
secret. Sending a test message needs only a full session: it discloses nothing.

### When delivery keeps failing

`GET /api/notifications/telegram` reports the queue: pending, sent, abandoned, the time of
the last success, and the **category** of the last failure — never Telegram's own message,
because those echo back what was sent. A row retries with exponential backoff (1 s
doubling to a 15-minute ceiling, jittered) and after **12 attempts** becomes a dead letter
that stays in the table: "the panel tried to tell you and could not" is itself information.
An unconfigured panel is the one exception — those rows wait and never dead-letter, so
configuring it later drains the backlog.

---

## Locked out

Work down this list. Each step assumes the ones above it did not work.

**1. You have the base path and the password but not a working authenticator.**
Use a recovery code in place of the TOTP code at stage two:

```bash
curl -sS -c "$JAR" -b "$JAR" -X POST "$PANEL/api/auth/login/totp" \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"code":"<one of the ten recovery codes>"}'
```

Note the field: a recovery code goes in **`code`**, the same field a TOTP code does. The
server tells them apart by shape — anything that is not six digits is treated as a recovery
code — so there is no separate parameter to get wrong. The response says
`"usedRecoveryCode": true` and how many remain.

Each code works once. Once you are in, re-enrol the authenticator and regenerate the codes
(`POST /api/security/recovery-codes`, step-up required) — the old ones are invalidated.

**2. You have lost the base path.** Set `PANEL_BASE_PATH` in Railway and redeploy, as in
the section above. Nothing else is affected.

**3. You have lost the authenticator and the recovery codes.** The panel cannot help you;
that is what mandatory 2FA means. But you have the volume. Open Railway's shell on the
service and turn two-factor off directly:

```bash
node -e "
const D=require('better-sqlite3');
const db=new D(process.env.PANEL_DATA_DIR + '/panel.db');
db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = 1').run();
db.prepare('DELETE FROM recovery_codes').run();
console.log('two-factor disabled; enrol again at next login');
"
```

Then log in with the password and enrol from scratch. Note what this is: **direct database
access is the recovery path**, so treat Railway dashboard access as equivalent to panel
access. The audit log records nothing about this, because it did not go through the panel —
which is itself worth knowing.

**4. You have lost the password too.** Delete the user row and let the panel re-seed it:
set `PANEL_ADMIN_USERNAME` and `PANEL_ADMIN_PASSWORD` again in Railway, then in the shell

```bash
node -e "
const D=require('better-sqlite3');
const db=new D(process.env.PANEL_DATA_DIR + '/panel.db');
db.prepare('DELETE FROM sessions').run();
db.prepare('DELETE FROM recovery_codes').run();
db.prepare('DELETE FROM users').run();
"
```

and redeploy. The audit log, the secrets and the base path all survive — only the account
is rebuilt. Remove the two variables again afterwards (step 12).

**5. You have lost `PANEL_MASTER_KEY`.** There is no recovery. The encrypted secrets are
unreadable and the audit log is unverifiable. Start a new volume and a new key. See
[Key rotation](./SECURITY.md#key-rotation) for why nothing can be done here.

---

## Backup and restore

### `cp panel.db` is not a backup

The database runs in WAL mode. A committed row lives in `panel.db-wal` until a checkpoint
folds it into the main file, so at any instant `panel.db` on its own is an **older**
database than the one being served — and a copy of `panel.db` plus a copy of `panel.db-wal`
taken a moment apart is not any database at all. Measured on a fresh install: a plain copy
of `panel.db` could not be opened as a panel database, because every table the migrations
created was still only in the WAL.

Use the commands. They go through SQLite's online backup API, which copies pages under the
engine's own locking and produces one consistent file with the WAL already folded in.

### Taking a backup

In Railway's shell on the service:

```bash
node dist/server/cli/backup.js /data/backups/panel-$(date +%F).db
```

Locally, against a local `.env`:

```bash
npm run backup -- ./backups/panel-$(date +%F).db
```

It refuses to overwrite an existing file without `--force`, because one bad snapshot
silently destroying the last good one is the failure that refusal exists for. Then it
**verifies what it wrote** rather than reporting success because the copy returned:
`PRAGMA integrity_check`, the migration count, and the audit chain under the current
`PANEL_MASTER_KEY`. A backup that cannot be verified is not a backup, and now is the moment
to find that out.

Download the file with `railway ssh` / the dashboard's file browser, or copy it out however
you normally would. A volume-local backup protects you from a bad restore and a bad
migration; it does not protect you from losing the volume.

### Store the backup and the key **apart**

**Either half alone is useless, and that is the point.**

- The backup **without** `PANEL_MASTER_KEY`: every stored secret is AES-256-GCM ciphertext
  you cannot decrypt, and every audit row is HMAC'd with a key you do not have, so the log
  cannot be verified. A restore under a different key fails verification with
  `hint: wrong_key_or_genesis` — the panel telling you, accurately, that this file and this
  key do not belong together.
- The key **without** the backup: nothing at all. It decrypts a file you do not have.

So: the backup goes wherever you keep backups; the key stays in the password manager. Not
both in the same bucket, and not the key in a comment next to the backup.

### Restoring

**Stop the service first.** Railway: Settings → **Remove Deployment**, or scale to zero.
Replacing the database file underneath a running server is how one database becomes two
halves of two, and `restore` refuses if anything holds a write lock — `--force` does not
override that.

```bash
node dist/server/cli/restore.js /data/backups/panel-2026-09-02.db
```

Locally, against a local `.env`:

```bash
npm run restore -- ./backups/panel-2026-09-02.db
```

It inspects the incoming file **before touching anything** (`integrity_check`, the schema,
the chain under the current key), takes a consistent safety copy of the database it is
about to replace, swaps through a temporary file and a rename so an interruption leaves one
whole database rather than half of each, removes the old `-wal`/`-shm` (a stale WAL next to
a restored database is corruption with a plausible timestamp), and then verifies what
landed.

Two refusals you will meet, both deliberate:

| It says | Why | What to do |
| --- | --- | --- |
| `the current database is not intact: its audit chain verifies over N rows` | A verifying chain is positive evidence that the live database is **fine**, and restoring over it destroys append-only history that nothing can recover. | If you mean it, `--force`. The replaced database is preserved as `panel.db.pre-restore-<timestamp>` and the report tells you the command to undo the restore. |
| `the snapshot verifies under this master key: … at its oldest row` | That is what a snapshot written under a **different** `PANEL_MASTER_KEY` looks like. If the key is wrong for the log it is wrong for the encrypted secrets too — which would surface later, when something read one, rather than now. | Find the right key. If you are certain and are about to supply it, `--force`. |

Afterwards, start the service and check:

```bash
node dist/server/cli/preflight.js     # audit chain verifies: N rows
curl -i https://<your-domain>/healthz
```

### What is *not* in a backup

The base path is (it is a row in `config/instance.json`, which is on the volume, but **not**
in `panel.db`) — so back up `config/instance.json` too, or record the base path separately.
`PANEL_MASTER_KEY` is not, by design. Neither is anything from the container filesystem,
which is ephemeral.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `exec /entrypoint.sh: no such file or directory` | CRLF line endings on the entrypoint. The kernel is looking for an interpreter called `/bin/sh\r`; the message names the file it just found, which is why it reads like a missing file. | `.gitattributes` pins `eol=lf`. Check out the repository again on a machine with `core.autocrlf` unset, or run `bash scripts/verify-image.sh` against the built image — it counts CR bytes in the entrypoint. |
| `FATAL: PANEL_MASTER_KEY is required` / `must be at least 32 bytes` | Variable missing, or a truncated paste. Base64 decoding never throws in Node — it discards what it cannot parse — so a short paste decodes cleanly to too few bytes. | Re-paste all 44 characters. `npm run preflight` reports the decoded byte count. |
| `FATAL: PANEL_PUBLIC_URL is required when NODE_ENV=production` | Neither `PANEL_PUBLIC_URL` nor `RAILWAY_PUBLIC_DOMAIN` is set. | Set `PANEL_PUBLIC_URL` to the https origin from Settings → Networking. |
| `FATAL: the public origin is http://… which is not https` | `PANEL_PUBLIC_URL` starts with `http://`. The panel refuses rather than silently shipping a session cookie without `Secure`. | Add the `s`. |
| `FATAL: … is not writable by uid 10001` and the deployment stops | The container started as a non-root uid on a root-owned volume mount. | Set `RAILWAY_RUN_UID=0` — [step 7](#7-why-railway_run_uid0-is-not-a-security-regression). |
| `FATAL: the panel is running as root … and refuses to serve` | Something overrode `ENTRYPOINT`, so the privilege drop never happened. | Restore `ENTRYPOINT ["/entrypoint.sh"]`. Do not set a `USER` in the Dockerfile — the entrypoint owns the drop. |
| `no such table: audit_log` right after the base-path banner | The build did not ship `dist/server/migrations/`, so zero migrations ran. `tsc` emits only what it compiles. | `npm run build` must be `tsc … && node scripts/copy-assets.mjs`. `tests/integration/build.test.ts` asserts the emitted `.sql` files against the source directory. |
| Healthcheck never passes; deployment marked failed | Either `/healthz` is answering `503` (the log line says `health check failed` and why) or the service is not reachable at all. | Read the deployment log. If `listenHost` is `127.0.0.1`, unset `PANEL_LISTEN_HOST`. |
| Every request to the panel is a `403` | `Host` does not match the configured public origin. | Compare the `publicOrigin` in the boot log with the domain you are using. A custom domain added later needs `PANEL_PUBLIC_URL` updated. |
| Login returns `200`, next request is `401`, browser console clean | The classic `PANEL_PUBLIC_URL` mismatch: the browser silently declined a `__Secure-` cookie because the scheme did not qualify. | [Step 6](#6-set-the-variables). Check `cookieProfile` and `sessionCookie` in the boot log. |
| Mutating requests return `403 Forbidden` from a script | Missing `X-CSRF-Token`, or a stale one. The token is bound to the session token's hash, so it dies whenever the session rotates. | Re-read the `…panel_csrf` cookie from the jar after every response that sets cookies. |
| `429` with `Retry-After` on ordinary use | The shared anonymous bucket (60 tokens, one back per second) — you are making unauthenticated requests in a loop. | Wait `Retry-After` seconds. Authenticated requests draw on a per-session bucket instead. |
| Login is slow, and slower each time | Working as designed. The progressive delay pads a failed attempt to a target: nothing for the first three failures, then 500 ms, 1 s, 2 s … capped at 30 s. It resets only when **both** factors are accepted. | Log in successfully. |
| `GET /api/audit/verify` says `row_hash_mismatch` at id 1 with `hint: wrong_key_or_genesis` | Almost always a changed or mistyped `PANEL_MASTER_KEY`, or a backup restored under a different one. A tamper cannot present this way — it would have to leave every earlier row intact. | Restore the original key. [Key rotation](./SECURITY.md#key-rotation). |
| `GET /api/audit/verify` says a mismatch at some row in the middle | That **is** the shape of a tamper. | Treat the volume as compromised. The rows before `brokenAtId` are still attested. |
| The panel forgot everything after a redeploy | The volume is not mounted where the panel is writing. | Settings → Volumes: mount path `/data`, or set `PANEL_DATA_DIR` to match. |
| A running agent died on its own (Phase 3 onward) | App Sleeping. | [Step 9](#9-turn-off-app-sleeping). |

---

## What to check after every deploy

```bash
curl -i https://<your-domain>/healthz                 # 200 {"ok":true}
node dist/server/cli/preflight.js                     # in Railway's shell — all checks pass
```

and in the deployment log, the one line that makes the three-way `PANEL_PUBLIC_URL`
dependency visible:

```
"msg":"panel configuration resolved"  →  publicOrigin, cookieProfile, sessionCookie, listenHost
```

Nothing in that line is a secret. The base path is not in it.

---

## Related documents

- [`docs/SECURITY.md`](./SECURITY.md) — every control, and the file that implements it.
  Read [Key rotation](./SECURITY.md#key-rotation) before you touch `PANEL_MASTER_KEY`.
- [`CLAUDE.md`](../CLAUDE.md) — architecture, and the decisions behind the security model.
- `scripts/verify-image.sh` — checks a built image for a `.env`, anything under
  `.localdata`, CR bytes in the entrypoint, and the tools that must not be installed yet.
- `scripts/container-smoke.sh` — a full two-stage login against a running container, with
  real `curl` and a real cookie jar.
