import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AvailKitClient, AvailKitError, type Fetch } from '../src/index.ts';

const options = { baseUrl: 'http://127.0.0.1:43291', workspaceId: 'binding/workspace', credential: 'synthetic-fetch-binding-only' };
const page = { events: [], nextAfter: 0, retentionFloor: 0, highWater: 0 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const failure = (kind: string, code: string, status?: number) => (error: unknown) =>
  error instanceof AvailKitError && error.kind === kind && error.code === code && error.status === status;

// This file runs serially in its own Node test process. Never patch application code.
async function withDefault(fetch: typeof globalThis.fetch, operation: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  assert(original);
  try {
    Object.defineProperty(globalThis, 'fetch', { ...original, value: fetch });
    await operation();
  } finally {
    Object.defineProperty(globalThis, 'fetch', original);
  }
}

test('default fetch keeps the global receiver and the exact request contract', async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  await withDefault(async function (this: unknown, url, init) {
    calls++;
    // Browser-native brand checks reject the SDK instance as receiver.
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    assert.equal(url, `${options.baseUrl}/v1/workspaces/binding%2Fworkspace/events?after=0&limit=1`);
    assert.equal(init?.method, 'GET');
    assert.equal(init.body, undefined);
    assert.deepEqual(init.headers, { Accept: 'application/json', Authorization: `Bearer ${options.credential}` });
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert(init.signal instanceof AbortSignal);
    signal = init.signal;
    assert.equal(signal.aborted, false);
    return json(page);
  }, async () => {
    assert.deepEqual(await new AvailKitClient(options).events({ after: 0, limit: 1 }), page);
  });
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true); // Existing finally cleanup still runs.
});

test('receiver-sensitive default fetch preserves structured scope denial', async () => {
  let calls = 0;
  await withDefault(async function (this: unknown) {
    calls++;
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return json({ error: { code: 'scope_denied', message: 'Synthetic denied request' } }, 403);
  }, async () => {
    await assert.rejects(new AvailKitClient(options).events(), failure('api', 'scope_denied', 403));
  });
  assert.equal(calls, 1);
});

test('explicit injected transport stays selected and unbound with safe error mapping', async () => {
  let calls = 0;
  let c: AvailKitClient;
  const fetch: Fetch = async function (this: unknown, url, init) {
    assert.equal(this, c); // Preserve existing injected-callback invocation semantics.
    assert.equal(url, `${options.baseUrl}/v1/workspaces/binding%2Fworkspace/events`);
    assert.equal(init.method, 'GET');
    calls++;
    if (calls === 2) throw new TypeError(options.credential);
    return json(page);
  };
  await withDefault(async () => { throw new Error('default transport must not be selected'); }, async () => {
    c = new AvailKitClient({ ...options, fetch });
    assert.deepEqual(await c.events(), page);
    await assert.rejects(c.events(), error => failure('transport', 'request_failed')(error) && !String(error).includes(options.credential));
  });
  assert.equal(calls, 2); // One send per explicit call, no retry.
});

test('default and injected transports still receive the deadline abort without retry', { timeout: 2000 }, async () => {
  for (const injected of [false, true]) {
    let calls = 0;
    let signal: AbortSignal | undefined;
    let completed: Promise<Response> | undefined;
    const transport: Fetch = function (this: unknown, _url, init) {
      assert.equal(this, injected ? c : globalThis);
      calls++;
      assert(init.signal instanceof AbortSignal);
      signal = init.signal;
      completed = new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true });
      });
      return completed;
    };
    let c: AvailKitClient;
    await withDefault(function (this: unknown, url, init) {
      assert(init);
      return transport.call(this, String(url), init);
    }, async () => {
      c = new AvailKitClient({ ...options, timeoutMs: 20, ...(injected ? { fetch: transport } : {}) });
      await assert.rejects(c.events(), failure('transport', 'timeout'));
      assert.equal(calls, 1);
      assert.equal(signal?.aborted, true);
      assert(completed);
      await assert.rejects(completed, /synthetic abort/); // Join the transport rejection.
    });
  }
});
