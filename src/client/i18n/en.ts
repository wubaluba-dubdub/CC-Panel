/**
 * English, and the **type** every other locale is declared against.
 *
 * ── Flat keys, on purpose ───────────────────────────────────────────────────
 *
 * Dotted string keys rather than nested objects, because `keyof typeof en` is then exactly
 * the set of valid keys — so `fa.ts` declared as `const fa: Dict` makes a missing or
 * misspelled Persian key a **compile error** rather than a runtime fallback, with no
 * recursive key-path type to maintain. Lookup is one property access.
 *
 * ── `{name}` placeholders are always machine values ─────────────────────────
 *
 * Every placeholder below is filled with something the panel computed: a count, a path, an
 * identifier, a timestamp. `t()` wraps each one in `<bdi>` itself, which is why it returns
 * a `ReactNode` and not a string — see `i18n/index.tsx`. A Latin value inside a Persian
 * sentence reorders visually without isolation, because the neutral characters at its edges
 * (`/` `.` `-` `:` `(`) resolve to the *paragraph's* direction rather than the run's, and
 * that reads as data corruption rather than as a layout bug.
 */
export const en = {
  // ── Chrome ───────────────────────────────────────────────────────────────
  'app.name': 'Control Panel',
  'app.signOut': 'Sign out',
  'app.signedInAs': 'Signed in as {username}',
  'nav.overview': 'Overview',
  'nav.sessions': 'Sessions',
  'nav.security': 'Security',
  'nav.secrets': 'Secrets',
  'nav.audit': 'Audit log',
  'nav.skipToContent': 'Skip to content',

  // ── Generic ──────────────────────────────────────────────────────────────
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.close': 'Close',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.loading': 'Loading…',
  'common.retry': 'Try again',
  'common.refresh': 'Refresh',
  'common.none': 'None',
  'common.never': 'Never',
  'common.unknown': 'Unknown',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.set': 'Set',
  'common.notSet': 'Not set',
  'common.characters': '{count} characters',
  'common.language': 'Language',
  // ── The table primitive ──────────────────────────────────────────────────
  // The expander's two states are words for a screen reader; the chevron is the sighted half.
  'table.expand': 'Show detail',
  'table.collapse': 'Hide detail',
  'table.more': '{count} more',
  // The exact instant, in a `title` on every timestamp. Both halves are machine values: the
  // local time with its UTC offset, and the same instant in UTC — which is what a Railway log
  // line is in, and therefore what makes a value on this screen usable as evidence.
  'time.exact': 'Exactly {local} — {utc} UTC',
  'common.english': 'English',
  'common.persian': 'فارسی',

  // ── Login ────────────────────────────────────────────────────────────────
  'login.title': 'Sign in',
  'login.username': 'Username',
  'login.password': 'Password',
  'login.submit': 'Continue',
  'login.working': 'Checking…',
  'login.slowWarning':
    'This can take up to thirty seconds. The delay grows with each failed attempt and is deliberate — it is what replaces locking the account.',
  'login.inProgress':
    'An attempt is already in progress. Only one runs at a time; wait for it to finish.',
  'login.failed': 'Those credentials were not accepted.',
  'login.rateLimited': 'Too many requests. Try again in {seconds} seconds.',

  'totp.title': 'Second factor',
  'totp.explain':
    'Enter the six-digit code from your authenticator. A recovery code goes in the same field.',
  'totp.code': 'Code',
  'totp.submit': 'Verify',
  'totp.failed': 'That code was not accepted.',
  'totp.expiresIn': 'This step expires in {time}.',
  'totp.expired':
    'The sign-in window closed after five minutes. Start again from the password screen.',
  'totp.usedRecoveryCode': 'A recovery code was used. {count} remain.',

  'enroll.title': 'Set up two-factor authentication',
  'enroll.explain':
    'Two-factor authentication is mandatory. Add this secret to an authenticator app, then enter the code it shows.',
  'enroll.secret': 'Secret',
  'enroll.uri': 'Or open this URI in your authenticator',
  'enroll.noQr':
    'The panel does not render a QR code: the image would have to be built from the secret, and there is nothing a camera can do that typing cannot.',
  'enroll.verify': 'Confirm the code',

  'recovery.title': 'Recovery codes',
  'recovery.explain':
    'Each code works once, in place of an authenticator code. This is the only time they are shown — the panel keeps only their hashes and cannot show them again.',
  'recovery.acknowledge': 'I have saved these codes',
  'recovery.remaining': '{count} unused recovery codes',
  'recovery.done': 'Continue',

  // ── Step-up ──────────────────────────────────────────────────────────────
  'stepup.title': 'Confirm it is you',
  'stepup.explain':
    'This action needs your password and a fresh authenticator code. The confirmation lasts five minutes on this session only.',
  'stepup.submit': 'Confirm',
  'stepup.active': 'Confirmed until {time}',
  'stepup.failed': 'That password or code was not accepted.',

  // ── Sessions ─────────────────────────────────────────────────────────────
  'sessions.title': 'Sessions',
  'sessions.explain':
    'Every session that can reach this panel. Revoking one takes effect on its next request — the panel keeps sessions on the server precisely so that revocation has no window.',
  'sessions.current': 'This device',
  'sessions.created': 'Started',
  'sessions.lastSeen': 'Last seen',
  'sessions.expires': 'Idle expiry',
  'sessions.absolute': 'Hard expiry',
  'sessions.level': 'Level',
  'sessions.levelPre': 'Password only',
  'sessions.levelFull': 'Both factors',
  'sessions.userAgent': 'Client',
  // The connecting word is translated and the two names are not: a browser is called Chrome in
  // Persian too, and both values come from a closed set — see `lib/user-agent.ts`.
  'sessions.clientSummary': '{browser} on {platform}',
  'sessions.clientRaw': 'The client string, exactly as received',
  'sessions.revoke': 'Revoke',
  'sessions.revokeOthers': 'Revoke all other sessions',
  'sessions.revoked': '{count} sessions revoked',
  'sessions.noIpNote':
    'No address column, deliberately: nothing in this panel decides anything from a client address, so it is not kept as something to act on.',

  // ── Security ─────────────────────────────────────────────────────────────
  'security.title': 'Security',
  'security.password.title': 'Change password',
  'security.password.new': 'New password',
  'security.password.repeat': 'Repeat it',
  'security.password.mismatch': 'The two entries do not match.',
  'security.password.consequence':
    'Every other session is revoked immediately. The only reason to change a password is that it may have leaked, and rotating one device would leave whoever you are worried about signed in.',
  'security.password.submit': 'Change password',
  'security.password.done': 'Password changed. {count} other sessions were revoked.',

  'security.recovery.title': 'Regenerate recovery codes',
  'security.recovery.consequence':
    'The ten existing codes stop working at once. The new ten are shown one time and never again.',
  'security.recovery.submit': 'Regenerate',

  'security.2fa.title': 'Disable two-factor authentication',
  'security.2fa.consequence':
    'Your password becomes the only thing between this panel and anyone who has found its address. The recovery codes are destroyed with it. There is no reason to do this except to move to a new authenticator, and re-enrolling does that without turning it off.',
  'security.2fa.submit': 'Disable two-factor',
  'security.2fa.done': 'Two-factor authentication is off. Enrol again from the sign-in screen.',

  'security.basePath.title': 'Regenerate the secret address',
  'security.basePath.consequence':
    'The address you are using now stops working. The panel has to be restarted for the new one to take effect, and until you open the new address there is no way back in — the panel cannot show it to you again from a page it no longer serves.',
  'security.basePath.submit': 'Regenerate the address',
  'security.basePath.typeToConfirm': 'Type {word} to confirm',
  'security.basePath.newValue': 'The new address',
  'security.basePath.saveIt':
    'Save this now, before restarting. It is also written to config/instance.json on the volume.',
  'security.basePath.restart': 'Restart the panel, then open the new address.',
  'security.basePath.envPinned':
    'PANEL_BASE_PATH is set in the environment, which wins on every boot. Change it there instead.',

  // ── Secrets ──────────────────────────────────────────────────────────────
  'secrets.title': 'Secrets',
  'secrets.explain':
    'Stored encrypted, and shown as set or unset with a length. Never a masked value: the last four characters of a nine-digit identifier are most of it.',
  'secrets.scope': 'Scope',
  'secrets.name': 'Name',
  'secrets.updated': 'Updated',
  'secrets.reveal': 'Reveal',
  'secrets.hide': 'Hide',
  'secrets.revealed': 'Hidden again in {seconds} seconds.',
  'secrets.revealWarning':
    'Revealing writes an audit row. The value leaves the page when it is hidden again.',
  'secrets.clipboardWarning':
    'The clipboard outlives this page and is readable by anything that can paste.',
  'secrets.set': 'Set a value',
  'secrets.value': 'Value',
  'secrets.save': 'Save',
  'secrets.saved': 'Saved.',
  'secrets.empty': 'No secrets are stored yet.',

  'telegram.title': 'Telegram notifications',
  'telegram.configured': 'Configured',
  'telegram.notConfigured': 'Not configured',
  'telegram.botToken': 'Bot token',
  'telegram.chatId': 'Chat id',
  'telegram.queue': 'Queue',
  'telegram.queueCounts':
    '{pending} waiting, {sending} in flight, {sent} sent, {abandoned} abandoned',
  'telegram.lastSuccess': 'Last delivered',
  'telegram.lastFailure': 'Last failure',
  'telegram.dropped': '{count} events refused because the queue was full',
  'telegram.test': 'Send a test message',
  'telegram.testQueued': 'Queued as {id}. Delivery is never synchronous.',
  'telegram.healthy': 'Delivering',
  'telegram.stale': 'Nothing has been delivered for {age}',
  'telegram.neverDelivered': 'Nothing has ever been delivered',
  'telegram.moreInM25': 'Configuring the bot is M2.5. This screen reports and tests only.',

  // ── Audit ────────────────────────────────────────────────────────────────
  'audit.title': 'Audit log',
  'audit.explain':
    'Append-only, and hash-chained under a key derived from the master key. There is no route that writes to it and there never will be.',
  'audit.when': 'When',
  'audit.event': 'Event',
  'audit.outcome': 'Outcome',
  'audit.client': 'Client',
  'audit.meta': 'Detail',
  'audit.metaRaw': 'The metadata, exactly as stored',
  'audit.filter': 'Event',
  'audit.filterAll': 'All events',
  'audit.more': 'Load older',
  'audit.end': 'That is the whole log.',
  'audit.verify': 'Verify the chain',
  'audit.verifyOk': 'The chain verifies over {count} rows.',
  'audit.verifyBroken': 'The chain does not verify. First break at row {id}: {reason}.',
  'audit.verifyHint':
    'A break at the oldest surviving row is far more likely a changed PANEL_MASTER_KEY than tampering — the row hashes are keyed, so a different key invalidates every row at once, while a tamper leaves everything before the edited row intact.',
  'audit.verifyMeaning':
    'A failure means a row was changed, removed, or added by something other than this panel. The log cannot repair itself; take a backup and compare it.',

  // ── Resources ────────────────────────────────────────────────────────────
  'resources.title': 'Resources',
  'resources.memory': 'Memory',
  'resources.cpu': 'CPU',
  'resources.disk': 'Volume',
  'resources.database': 'Database',
  'resources.usedOfLimit': '{used} of {limit}',
  'resources.noLimit': 'No limit reported by this container, so there is no percentage to show.',
  'resources.measuring': 'Measuring…',
  'resources.cpuOfQuota': '{percent} of {cores} cores',
  'resources.hostWide':
    'These figures describe the host, not the panel: the cgroup could not be read, and the host has far more memory than this container may use.',
  'resources.available': '{available} available',
  'resources.watchdog': 'Alerts',
  'resources.watchdogOff': 'The watchdog is switched off, so nothing is being watched.',
  'resources.armed': 'Watching, alerting at {threshold}',
  'resources.disarmedNoLimit': 'Off: this container reports no memory limit, so there is nothing to be a percentage of.',
  'resources.disarmedUnavailable': 'Off: the figure cannot be read here.',
  'resources.disarmedDisabled': 'Off: the watchdog is disabled.',
  'resources.above': 'Above the threshold since {time}',
  'resources.clearing': 'Below the clear line since {time}; recovery is sent once it stays there for {window}.',
  'resources.oomKills': '{count} processes killed for memory',
  'resources.oomNoBaseline': 'The kill counter has not been read yet.',
  'resources.uncleanRestart':
    'The previous run did not shut down cleanly. It was last seen at {time} using {used}.',
  'resources.cleanRestart': 'The previous run shut down cleanly.',
  'resources.notChecked': 'The previous run was not checked, because the watchdog is off.',
  'resources.sampledAt': 'Sampled {time}',

  // ── Errors, keyed by the server's code enum ──────────────────────────────
  'error.unauthenticated': 'You are not signed in.',
  'error.stepUpRequired': 'That action needs a fresh confirmation.',
  'error.csrfInvalid': 'The request was rejected for safety. Reload the page and try again.',
  'error.rateLimited': 'Too many requests. Try again in {seconds} seconds.',
  'error.authInProgress': 'An authentication attempt is already running.',
  'error.badCredentials': 'Those credentials were not accepted.',
  'error.weakPassword': 'That password is too weak or too common.',
  'error.notFound': 'That does not exist.',
  'error.conflict': 'That cannot be done in the panel’s current state.',
  'error.tooLarge': 'That request was too large.',
  'error.badRequest': 'The panel could not read that request.',
  'error.server': 'Something went wrong on the server. The reason is in the log, not here.',
  'error.network': 'The panel could not be reached.',
  'error.unknown': 'Something went wrong.',

  // ── Not found ────────────────────────────────────────────────────────────
  'notFound.title': 'No such page',
  'notFound.explain': 'This address is not part of the panel.',
  'notFound.home': 'Go to the overview',
} as const;

/** The shape every other locale is declared against. */
export type Dict = Record<keyof typeof en, string>;

export type TranslationKey = keyof typeof en;
