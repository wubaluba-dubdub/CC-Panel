import type {} from '../../src/client/global.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiError,
  NetworkError,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  setApiHandlers,
  updateProject,
} from '../../src/client/lib/api.js';

/**
 * The project half of `src/client/lib/api.ts`, in Node with a stubbed `fetch`.
 *
 * What a test here can see and what it cannot, because the difference is the whole
 * reason the file exists:
 *
 *  - **It sees the bytes the browser would send**: the URL with the secret prefix on
 *    it, the method, the headers, the JSON body. That is the contract M2.5's screens
 *    will depend on and the one place the base path is allowed to be read from
 *    `window.__BASE__`.
 *  - **It does not see the server.** Nothing here proves a route exists or that a
 *    guard holds; `tests/integration/project-routes.test.ts` does that against a real
 *    Fastify instance. Duplicating those assertions here would only mean keeping two
 *    files in step.
 *
 * The environment is Node's, so `window` and `document` are installed by hand — exactly
 * the two globals `bootstrap.js` provides in a browser and that this module reads.
 */

const BASE = 'sesame';
const CSRF_NAME = 'panel_csrf';
const CSRF_VALUE = 'token-from-the-cookie';

interface Reply {
  status: number;
  body?: unknown;
}

interface Call {
  url: string;
  init: RequestInit;
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

function lastCall(): Call {
  const call = calls.at(-1);
  if (call === undefined) throw new Error('no request was made');
  return call;
}

function header(call: Call, name: string): string | undefined {
  const headers = (call.init.headers ?? {}) as Record<string, string>;
  return headers[name];
}

describe('the five project functions build the right request', () => {
  it('lists with GET, no body, and no CSRF header', async () => {
    fallback = { status: 200, body: { projects: [] } };
    const result = await listProjects();
    expect(result).toEqual({ projects: [] });

    const call = lastCall();
    expect(call.url).toBe(`/${BASE}/api/projects`);
    expect(call.init.method).toBe('GET');
    // Safe methods are exempt server-side, so sending the token would be a token in a
    // place it is never checked.
    expect(header(call, 'X-CSRF-Token')).toBeUndefined();
    expect(header(call, 'Content-Type')).toBeUndefined();
    expect(call.init.credentials).toBe('same-origin');
    expect(call.init.redirect).toBe('error');
    expect(call.init.cache).toBe('no-store');
  });

  it('reads one, encoding the path parameter', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    fallback = {
      status: 200,
      body: {
        id: 1,
        uuid,
        slug: 'a-b-c',
        renamed: false,
        isolatedSettings: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const dto = await getProject(uuid);
    expect(dto.slug).toBe('a-b-c');
    expect(lastCall().url).toBe(`/${BASE}/api/projects/${uuid}`);
    expect(lastCall().init.method).toBe('GET');

    // Every path parameter goes through `encodeURIComponent`, not only the ones that are
    // uuids today: the day one stops being a uuid the rule is already in place.
    await getProject('a/b?c#d');
    expect(lastCall().url).toBe(`/${BASE}/api/projects/a%2Fb%3Fc%23d`);
  });

  it('creates with POST, JSON body, and the CSRF header', async () => {
    fallback = { status: 201, body: { uuid: 'u', slug: 'a-b-c' } };
    const dto = await createProject({ slug: 'a-b-c' });
    expect(dto.slug).toBe('a-b-c');

    const call = lastCall();
    expect(call.url).toBe(`/${BASE}/api/projects`);
    expect(call.init.method).toBe('POST');
    expect(header(call, 'Content-Type')).toBe('application/json');
    expect(header(call, 'X-CSRF-Token')).toBe(CSRF_VALUE);
    expect(call.init.body).toBe(JSON.stringify({ slug: 'a-b-c' }));
  });

  it('patches with PATCH and the partial body it was given', async () => {
    fallback = { status: 200, body: { uuid: 'u', slug: 'a-new-name' } };
    await updateProject('u', { isolatedSettings: true });

    const call = lastCall();
    expect(call.url).toBe(`/${BASE}/api/projects/u`);
    expect(call.init.method).toBe('PATCH');
    expect(header(call, 'X-CSRF-Token')).toBe(CSRF_VALUE);
    expect(call.init.body).toBe(JSON.stringify({ isolatedSettings: true }));
  });

  it('deletes with DELETE, no body, and resolves to undefined on 204', async () => {
    fallback = { status: 204 };
    await expect(deleteProject('u')).resolves.toBeUndefined();

    const call = lastCall();
    expect(call.url).toBe(`/${BASE}/api/projects/u`);
    expect(call.init.method).toBe('DELETE');
    expect(call.init.body).toBeUndefined();
    expect(header(call, 'X-CSRF-Token')).toBe(CSRF_VALUE);
  });
});

describe('what the caller sees when the server says no', () => {
  it('turns a 403 step_up_required into exactly one prompt and one retry', async () => {
    // The whole story of DELETE: the server answers 403, the shell asks for a fresh
    // confirmation, and the second attempt is the one that takes effect. A second retry
    // would be a dialog the operator cannot escape.
    replies = [
      { status: 403, body: { error: 'Forbidden', code: 'step_up_required' } },
      { status: 204 },
    ];
    let prompts = 0;
    setApiHandlers({
      onStepUpRequired: async () => {
        prompts += 1;
        return true;
      },
    });

    await expect(deleteProject('u')).resolves.toBeUndefined();
    expect(prompts).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.init.method).toBe('DELETE');
  });

  it('propagates a second 403 rather than prompting forever', async () => {
    replies = [
      { status: 403, body: { error: 'Forbidden', code: 'step_up_required' } },
      { status: 403, body: { error: 'Forbidden', code: 'step_up_required' } },
    ];
    let prompts = 0;
    setApiHandlers({
      onStepUpRequired: async () => {
        prompts += 1;
        return true;
      },
    });

    await expect(deleteProject('u')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'step_up_required',
    });
    expect(prompts).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('carries the closed code through, and never a server-written sentence', async () => {
    fallback = { status: 507, body: { error: 'Insufficient Storage', code: 'insufficient_storage' } };
    const err = await createProject({ slug: 'a-b-c' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const api = err as ApiError;
    expect(api.status).toBe(507);
    expect(api.code).toBe('insufficient_storage');
    // The message is for a devtools stack, and it is built from the two things this
    // client already knows — never from the reason phrase.
    expect(api.message).toBe('api 507 insufficient_storage');

    fallback = { status: 429, body: { error: 'Too Many Requests', code: 'rate_limited' } };
    const limited = (await listProjects().catch((e: unknown) => e)) as ApiError;
    expect(limited.code).toBe('rate_limited');
  });

  it('reports an unreachable panel as NetworkError, with no cause from underneath', async () => {
    networkFails = true;
    const err = await listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).code).toBe('network');
    expect((err as NetworkError).message).toBe('api unreachable');
    expect((err as NetworkError).cause).toBeUndefined();
  });
});

describe('the one thing this file is not allowed to guess', () => {
  it('sends nothing at all when bootstrap.js did not set the base path', async () => {
    // `basePath()` throws inside the `try` that wraps `fetch`, so the message is folded
    // into `NetworkError` rather than surfaced — see §17 of this prompt's report. What
    // matters here is the property: nothing is sent. A request built without the prefix
    // would go to a path that answers the generic 404, which reads as "no such route".
    globals.window = { __CSRF_COOKIE__: CSRF_NAME };
    await expect(listProjects()).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toHaveLength(0);
  });

  it('reads the CSRF cookie by the name the server gave, not by a hard-coded one', async () => {
    // The prefixed spelling a real https deployment uses, supplied by `bootstrap.js`.
    globals.window = { __BASE__: `/${BASE}`, __CSRF_COOKIE__: '__Secure-panel_csrf' };
    globals.document = { cookie: `__Secure-panel_csrf=${CSRF_VALUE}` };
    fallback = { status: 201, body: { uuid: 'u' } };

    await createProject({ slug: 'a-b-c' });
    expect(header(lastCall(), 'X-CSRF-Token')).toBe(CSRF_VALUE);

    // And with no cookie at all the header is simply absent — a `GET` does not need it,
    // and a request with no session has no token to send.
    globals.document = { cookie: '' };
    await listProjects();
    expect(header(lastCall(), 'X-CSRF-Token')).toBeUndefined();
  });
});
