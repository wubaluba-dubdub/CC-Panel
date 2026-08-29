import { describe, it, expect, vi } from 'vitest';
import { format, inspect } from 'node:util';
import { REDACTED, SecretString, mask } from '../../src/server/crypto.js';
import {
  containsRedactableSecret,
  redactSecrets,
} from '../../src/server/plugins/logger-redaction.js';

const SECRET = 'sk-ant-api03-0123456789abcdefa1b2';

describe('SecretString', () => {
  it('returns the value only through reveal()', () => {
    const secret = new SecretString(SECRET);
    expect(secret.reveal()).toBe(SECRET);
  });

  it('redacts each override independently', () => {
    const secret = new SecretString(SECRET);

    // Asserted one by one, not just through coercion: Symbol.toPrimitive takes
    // precedence over toString for every implicit path, so a leaking toString
    // would otherwise be invisible to the tests below.
    expect(secret.toString()).toBe(REDACTED);
    expect(secret.toJSON()).toBe(REDACTED);
    expect((secret as unknown as { [Symbol.toPrimitive](): string })[Symbol.toPrimitive]()).toBe(
      REDACTED,
    );
    expect((secret as unknown as Record<symbol, () => string>)[inspect.custom]!()).toBe(REDACTED);
  });

  it('does not leak through string interpolation', () => {
    const secret = new SecretString(SECRET);
    expect(`${secret}`).toBe(REDACTED);
    expect(String(secret)).toBe(REDACTED);
    expect(secret + '').toBe(REDACTED);
    expect(''.concat(secret as unknown as string)).toBe(REDACTED);
    expect([secret].join(',')).toBe(REDACTED);
  });

  it('does not leak through JSON.stringify, at any nesting depth', () => {
    const secret = new SecretString(SECRET);
    expect(JSON.stringify(secret)).toBe(`"${REDACTED}"`);
    expect(JSON.stringify({ token: secret })).toBe(`{"token":"${REDACTED}"}`);
    expect(JSON.stringify({ a: { b: [secret] } })).toBe(`{"a":{"b":["${REDACTED}"]}}`);
  });

  it('does not leak through util.inspect, at any nesting depth', () => {
    const secret = new SecretString(SECRET);
    expect(inspect(secret)).toBe(REDACTED);
    expect(inspect({ token: secret })).toContain(REDACTED);
    expect(inspect({ token: secret })).not.toContain(SECRET);
    expect(inspect({ a: { b: [secret] } }, { depth: 10 })).not.toContain(SECRET);
  });

  it('does not leak through console.log', () => {
    const secret = new SecretString(SECRET);
    const rendered: string[] = [];

    // Asserted against util.format rather than by capturing process.stdout:
    // vitest replaces the console transport, so a stdout spy sees nothing. This
    // is the same formatting machinery console.log itself uses.
    const collect = (...args: unknown[]): void => {
      rendered.push(format(...args));
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(collect);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(collect);

    try {
      console.log(secret);
      console.log('token=%s', secret);
      console.log('token=%o', secret);
      console.log({ nested: { token: secret } });
      console.error(secret);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const output = rendered.join('\n');
    expect(output).not.toContain(SECRET);
    expect(output).toContain(REDACTED);
    expect(rendered).toHaveLength(5);
  });

  it('does not expose the value on any enumerable property', () => {
    const secret = new SecretString(SECRET);

    expect(Object.keys(secret)).toEqual([]);
    expect(Object.entries(secret)).toEqual([]);
    expect(Object.getOwnPropertyNames(secret)).toEqual([]);
    expect(JSON.stringify({ ...secret })).toBe('{}');
    expect(inspect(Object.getOwnPropertyDescriptors(secret))).not.toContain(SECRET);
  });

  it('offers a masked display form', () => {
    expect(new SecretString(SECRET).mask()).toBe('sk-ant-…a1b2');
  });

  it('identifies itself in inspect output as a SecretString', () => {
    expect(Object.prototype.toString.call(new SecretString(SECRET))).toBe('[object SecretString]');
  });
});

describe('mask', () => {
  it('keeps a recognised credential prefix and the last four characters', () => {
    expect(mask('sk-ant-api03-0123456789abcdefa1b2')).toBe('sk-ant-…a1b2');
    expect(mask('ghp_0123456789abcdefghij')).toBe('ghp_…ghij');
    expect(mask('gho_0123456789abcdefghij')).toBe('gho_…ghij');
    expect(mask('github_pat_0123456789abcdefghij')).toBe('github_pat_…ghij');
    expect(mask('sk-proj-0123456789abcdefwxyz')).toBe('sk-…wxyz');
  });

  it('reveals nothing but the last four characters of an unrecognised value', () => {
    expect(mask('completely-opaque-value-6789')).toBe('…6789');
  });

  it('never reveals more than the last four characters', () => {
    const value = 'abcdefghijklmnop';
    const masked = mask(value);
    const revealed = masked.replace(/^.*…/, '');

    expect(revealed).toBe('mnop');
    expect(revealed).toHaveLength(4);
    expect(masked).not.toContain('abcdefghijkl');
  });

  it('returns a fixed placeholder below eight characters', () => {
    for (const short of ['', 'a', 'abc', 'sk-ant-', 'abcdefg']) {
      expect(mask(short), JSON.stringify(short)).toBe(REDACTED);
    }
  });

  it('drops the prefix rather than overlap it with the revealed tail', () => {
    // 'sk-ant-' is 7 characters; only one character of secret material follows,
    // so keeping the prefix would reveal the whole value.
    expect(mask('sk-ant-x')).toBe('…nt-x');
    expect(mask('sk-ant-x')).not.toContain('sk-ant-');
  });
});

describe('logger redaction', () => {
  it('scrubs Anthropic keys', () => {
    const line = 'calling api with sk-ant-api03-0123456789abcdefa1b2 now';
    expect(redactSecrets(line)).toBe(`calling api with sk-ant-${REDACTED} now`);
  });

  it('scrubs GitHub tokens of every shape', () => {
    expect(redactSecrets('ghp_0123456789abcdefghij')).toBe(`ghp_${REDACTED}`);
    expect(redactSecrets('gho_0123456789abcdefghij')).toBe(`gho_${REDACTED}`);
    expect(redactSecrets('github_pat_0123456789abcdefghij')).toBe(`github_pat_${REDACTED}`);
  });

  it('scrubs generic sk- keys without mislabelling Anthropic ones', () => {
    expect(redactSecrets('sk-proj-0123456789abcdefgh')).toBe(`sk-${REDACTED}`);
    // The sk-ant- rule has to win, or an Anthropic key gets reported as an
    // OpenAI-shaped one.
    expect(redactSecrets('sk-ant-api03-0123456789abcdef')).toBe(`sk-ant-${REDACTED}`);
  });

  it('scrubs JWT-shaped strings', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redactSecrets(`Authorization: Bearer ${jwt}`)).toBe(
      'Authorization: Bearer [redacted-jwt]',
    );
  });

  it('scrubs every occurrence on a line, not just the first', () => {
    const line = 'a=ghp_0123456789abcdefghij b=ghp_zzzzzzzzzzzzzzzzzzzz';
    expect(redactSecrets(line)).toBe(`a=ghp_${REDACTED} b=ghp_${REDACTED}`);
  });

  it('leaves ordinary text alone', () => {
    for (const benign of [
      'GET /healthz 200',
      'version 1.2.3',
      'sk-short',
      'file.name.ext',
      'a.b.c',
      'not_a_token github_pat_short',
    ]) {
      expect(redactSecrets(benign), benign).toBe(benign);
      expect(containsRedactableSecret(benign), benign).toBe(false);
    }
  });

  it('reports whether a string still holds something redactable', () => {
    expect(containsRedactableSecret('sk-ant-api03-0123456789abcdef')).toBe(true);
    expect(containsRedactableSecret('nothing here')).toBe(false);
  });

  it('is a second line of defence, not a replacement for SecretString', () => {
    // An opaque secret matches no pattern, so redaction cannot save it. This is
    // exactly why the value must be held in a SecretString.
    const opaque = 'zX7q-opaque-credential-value';
    expect(redactSecrets(opaque)).toBe(opaque);
    expect(`${new SecretString(opaque)}`).toBe(REDACTED);
  });
});
