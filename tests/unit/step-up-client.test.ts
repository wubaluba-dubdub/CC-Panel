import type {} from '../../src/client/global.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiError,
  deleteProject,
  listProjects,
  requestStepUp,
  setApiHandlers,
} from '../../src/client/lib/api.js';

/**
 * Step-up as the client handles it, in Node with a stubbed `fetch`.
 *
 * The defect this file exists for, observed in production: `POST /api/auth/step-up` answers
 * **401 `bad_credentials`** for a wrong password, a wrong or replayed code, or a wrong
 * recovery code, and deliberately leaves the full session standing — but the client read that
 * 401 as *the session is gone* and ran the global drop-to-login. The operator was returned to
 * the sign-in screen from inside the dialog they had opened two seconds earlier, while the
 * deletion they had not yet confirmed was still pending behind it.
 *
 * What a test here sees: whether the global unauthenticated handler fires, how many requests
 * went out and in what order, and which `ApiError` the caller catches. That is the whole
 * contract, because `App.tsx` calls `forget()` — and only `forget()` — from `onUnauthenticated`:
 * "the shell and session state survived" and "the handler never fired" are the same statement.
 *
 * What it does not see: React. That `StepUpForm` sends its submission through
 * `requestStepUp()` and renders one generic message for every credential failure is a source
 * assertion in `tests/integration/m22-ui.test.ts`, because this suite has no DOM.
 */

const BASE = 'sesame';
const CSRF_NAME = 'panel_csrf';
const CSRF_VALUE = 'token-from-the-cookie';

/** The body `HttpError(401, 'invalid credentials', 'bad_credentials')` puts on the wire. */
const BAD_CREDENTIALS = { error: 'invalid credentials', code: 'bad_credentials' };
const NEEDS_STEP_UP = { error: 'Forbidden', code: 'step_up_required' };

interface Reply {
  status: number;
  body?: unknown;
}

interface Call {
  url: string;
  init: RequestInit;
}

/** The two handlers `App.tsx` registers, counted so a call cannot pass unnoticed. */
interface Watch {
  dropped: number;
  prompts: number;
}

let calls: Call[] = [];
let replies: Reply[] = [];
let fallback: Reply = { status: 200, body: {} };
let networkFails = false;

const globals = globalThis as unknown as {
  window?: unknown;
  document?: unknown;
  fetch?: unknown;
};
const originalFetch = globalThis.fetch;

function install(): void {
  globals.window = { __BASE__: `/${BASE}`, __CSRF_COOKIE__: CSRF_NAME };
  globals.document = { cookie: `${CSRF_NAME}=${CSRF_VALUE}` };
  globals.fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    if (networkFails) throw new TypeError('Failed to fetch');
    calls.push({ url: String(input), init: init ?? {} });
    const reply = replies.shift() ?? fallback;
    if (reply.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

beforeEach(() => {
  calls = [];
  replies = [];
  fallback = { status: 200, body: {} };
  networkFails = false;
  install();
});

afterEach(() => {
  delete globals.window;
  delete globals.document;
  globals.fetch = originalFetch;
  setApiHandlers({});
});

/**
 * Registers both handlers the shell registers, counting every invocation.
 *
 * `onStepUpRequired` is whatever the caller passes, so a test can model the dialog: resolve
 * `true` on a granted step-up, `false` on a cancel or on a submission that never succeeded.
 */
function watch(onStepUp: () => Promise<boolean> = async () => false): Watch {
  const w: Watch = { dropped: 0, prompts: 0 };
  setApiHandlers({
    onUnauthenticated: () => {
      w.dropped += 1;
    },
    onStepUpRequired: async () => {
      w.prompts += 1;
      return onStepUp();
    },
  });
  return w;
}

function methods(): string[] {
  return calls.map((call) => String(call.init.method));
}

describe('a failed step-up is a wrong credential, not a lost session', () => {
  it('opts out of the global 401-to-login behaviour', async () => {
    const w = watch();
    fallback = { status: 401, body: BAD_CREDENTIALS };

    const err = await requestStepUp('not-the-password', '000000').catch((e: unknown) => e);

    // The handler `App.tsx` wires to `forget()` — the thing that returned the operator to the
    // sign-in screen mid-dialog — must not run for this endpoint's 401.
    expect(w.dropped, 'the shell dropped to the login screen').toBe(0);
    // And step-up must never prompt for step-up: the prompt is this same dialog.
    expect(w.prompts).toBe(0);
    // One request and no more: no silent second attempt, and nothing else sent on its behalf.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`/${BASE}/api/auth/step-up`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(err).toBeInstanceOf(ApiError);
  });

  it('hands the dialog the closed code and never the sentence the server wrote', async () => {
    const w = watch();
    fallback = { status: 401, body: BAD_CREDENTIALS };

    const err = (await requestStepUp('not-the-password', '000000').catch(
      (e: unknown) => e,
    )) as ApiError;

    expect(err.status).toBe(401);
    // The code the dialog's `else` branch folds into the one localized generic message. The
    // server names no credential in it either — wrong password, wrong code, replayed code and
    // wrong recovery code are all this same code, by design.
    expect(err.code).toBe('bad_credentials');
    expect(err.message).toBe('api 401 bad_credentials');
    expect(err.message).not.toContain('invalid credentials');
    expect(w.dropped).toBe(0);
  });

  it('leaves the pending destructive request unsent after a credential failure', async () => {
    // The whole production sequence: DELETE is refused for want of a step-up, the dialog opens,
    // the operator submits a wrong password, the dialog stays put and resolves `false` — so the
    // DELETE must not go out a second time. It never went out successfully either, so no project
    // is deleted.
    const w = watch(async () => {
      const granted = await requestStepUp('not-the-password', '000000')
        .then(() => true)
        .catch(() => false);
      return granted;
    });
    replies = [
      { status: 403, body: NEEDS_STEP_UP },
      { status: 401, body: BAD_CREDENTIALS },
    ];

    await expect(deleteProject('u')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'step_up_required',
    });
    expect(methods()).toEqual(['DELETE', 'POST']);
    expect(w.dropped, 'the shell dropped to the login screen').toBe(0);
    expect(w.prompts).toBe(1);
  });

  it('retries the original request exactly once after a step-up that succeeds', async () => {
    const w = watch(() => requestStepUp('correct-horse', '123456').then(() => true));
    replies = [
      { status: 403, body: NEEDS_STEP_UP },
      { status: 200, body: { stepUpUntil: '2026-01-01T00:05:00.000Z' } },
      { status: 204 },
    ];

    await expect(deleteProject('u')).resolves.toBeUndefined();
    expect(methods()).toEqual(['DELETE', 'POST', 'DELETE']);
    expect(w.prompts).toBe(1);
    expect(w.dropped).toBe(0);
  });

  it('retries nothing at all when the operator cancels', async () => {
    const w = watch(async () => false);
    replies = [{ status: 403, body: NEEDS_STEP_UP }];

    await expect(deleteProject('u')).rejects.toMatchObject({ code: 'step_up_required' });
    expect(methods()).toEqual(['DELETE']);
    expect(w.prompts).toBe(1);
    expect(w.dropped).toBe(0);
  });
});

describe('the drop-to-login path is still there for everything else', () => {
  it('runs the global unauthenticated handler for an ordinary request that answers 401', async () => {
    // The other half of the contract, and the reason the fix is an opt-out on one request
    // rather than a softer reading of 401: a session revoked from another device, rotated out
    // from under a stale tab, or expired must still get the operator back to the sign-in
    // screen instead of leaving a screen full of stale data that 401s on every action.
    const w = watch();
    fallback = { status: 401, body: { error: 'Unauthorized', code: 'unauthenticated' } };

    await expect(listProjects()).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      code: 'unauthenticated',
    });
    expect(w.dropped).toBe(1);
    expect(w.prompts).toBe(0);
  });
});
