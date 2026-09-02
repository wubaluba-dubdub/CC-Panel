/**
 * The shared shape of the three operator commands: `preflight`, `backup`, `restore`.
 *
 * They exist because the alternative is a runbook that says "check that the volume is
 * writable" and leaves the operator to work out how. Every one of them prints a
 * pass/fail line per fact and exits non-zero if any of them failed, so the answer to
 * "is this deployment configured correctly" is a command rather than a reading
 * exercise.
 *
 * **No secret value is ever printed.** For a credential the report carries only
 * whether it is set and how many characters it has — enough to catch a truncated paste
 * or a variable that never made it into the environment, and nothing more. The base
 * path is treated as a secret too: it is the one thing in the configuration that the
 * whole obscurity layer depends on, and a runbook that has the operator print it to a
 * terminal (and their shell history, and their scrollback, and whatever is recording
 * the session) has given it away.
 */

export type Status = 'pass' | 'fail' | 'warn' | 'info';

export interface Line {
  status: Status;
  label: string;
  detail?: string;
}

const COLOURS: Record<Status, string> = {
  pass: '[32m',
  fail: '[31m',
  warn: '[33m',
  info: '[36m',
};

const LABELS: Record<Status, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  warn: 'WARN',
  info: 'INFO',
};

/** True when stdout is a terminal. Piping the output to a file should not embed escapes. */
function colourise(status: Status): string {
  const tag = LABELS[status];
  return process.stdout.isTTY === true ? `${COLOURS[status]}${tag}[0m` : tag;
}

export class Report {
  readonly #lines: Line[] = [];
  readonly #write: (text: string) => void;

  constructor(write: (text: string) => void = (text) => process.stdout.write(text)) {
    this.#write = write;
  }

  section(title: string): void {
    this.#write(`\n${title}\n`);
  }

  add(status: Status, label: string, detail?: string): void {
    const line: Line = detail === undefined ? { status, label } : { status, label, detail };
    this.#lines.push(line);
    this.#write(`  ${colourise(status)}  ${label}${detail === undefined ? '' : `: ${detail}`}\n`);
  }

  pass(label: string, detail?: string): void {
    this.add('pass', label, detail);
  }
  fail(label: string, detail?: string): void {
    this.add('fail', label, detail);
  }
  warn(label: string, detail?: string): void {
    this.add('warn', label, detail);
  }
  info(label: string, detail?: string): void {
    this.add('info', label, detail);
  }

  get lines(): readonly Line[] {
    return this.#lines;
  }

  get failures(): number {
    return this.#lines.filter((l) => l.status === 'fail').length;
  }

  get warnings(): number {
    return this.#lines.filter((l) => l.status === 'warn').length;
  }

  /** Writes the summary and returns the process exit code. */
  finish(): number {
    const { failures, warnings } = this;
    this.#write('\n');
    if (failures === 0) {
      this.#write(
        warnings === 0
          ? 'All checks passed.\n'
          : `All checks passed, with ${warnings} warning(s).\n`,
      );
      return 0;
    }
    this.#write(`${failures} check(s) failed.\n`);
    return 1;
  }
}

/**
 * How a secret is allowed to appear in output: set or not, and how long.
 *
 * A length is genuinely useful — it catches the two mistakes that actually happen, a
 * variable that never reached the environment and a value truncated by a paste — and
 * reveals nothing an attacker can use. It is also all that is allowed.
 */
export function describeSecret(value: string | undefined): string {
  if (value === undefined) return 'not set';
  if (value.length === 0) return 'set but empty';
  return `set, ${value.length} characters`;
}
