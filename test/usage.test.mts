import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { AvailKitClient, AvailKitError } from '../src/index.ts';
import type { Fetch, Usage } from '../src/index.ts';
import { runCli, help } from '../src/cli.mts';

const credential = 'synthetic-usage-credential';
const env = { AVAILKIT_BASE_URL: 'http://127.0.0.1', AVAILKIT_WORKSPACE_ID: 'ws/one', AVAILKIT_CREDENTIAL: credential };
const counterKeys = ['monthlyBookingCreates', 'catalogObjects', 'bookingRecords', 'committedEvents', 'webhookSubscriptions', 'webhookDeliveries', 'liveReplays', 'customerRecords'] as const;
const fixture = (): Usage => ({
  asOf: '2026-10-18T12:00:00Z', period: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
  counters: Object.fromEntries(counterKeys.map(k => [k, { used: 1, limit: 10, remaining: 9 }])) as Usage['counters'],
});
const json = (data: unknown, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const client = (fetch: Fetch, extra = {}) => new AvailKitClient({ baseUrl: env.AVAILKIT_BASE_URL, workspaceId: env.AVAILKIT_WORKSPACE_ID, credential, fetch, ...extra });
const protocol = (e: unknown) => e instanceof AvailKitError && e.kind === 'protocol' && !JSON.stringify(e).includes(credential);

test('usage sends one exact workspace GET with no query/body/key and safe transport headers', async () => {
  let calls = 0;
  const value = fixture();
  const c = client(async (url, init) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1/v1/workspaces/ws%2Fone/usage');
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.deepEqual(Object.fromEntries(new Headers(init.headers)), { accept: 'application/json', authorization: `Bearer ${credential}` });
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'omit');
    assert(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted, false);
    return json(value);
  });
  assert.deepEqual(await c.getUsage(), value); assert.equal(calls, 1);
});

test('all eight counters allow zero, exact limit, over limit and safe-integer bounds', async () => {
  for (const [used, limit] of [[0, 0], [0, 10], [10, 10], [11, 10], [Number.MAX_SAFE_INTEGER, 0], [0, Number.MAX_SAFE_INTEGER]]) {
    const value = fixture();
    for (const k of counterKeys) value.counters[k] = { used, limit, remaining: Math.max(0, limit - used) };
    assert.deepEqual(await client(async () => json(value)).getUsage(), value);
  }
});

test('rejects nonobjects, missing/extra/private fields at every closed object boundary', async () => {
  const bad: unknown[] = [null, [], {}, { ...fixture(), payload: credential }, { ...fixture(), counters: { ...fixture().counters, private: credential } }];
  for (const field of ['asOf', 'period', 'counters']) {
    const value = fixture() as any; delete value[field]; bad.push(value);
  }
  for (const field of ['start', 'end']) {
    const value = fixture() as any; delete value.period[field]; bad.push(value);
  }
  for (const part of ['period', 'counters']) {
    for (const replacement of [null, [], 'private', { ...fixture()[part as 'period'], signingSecret: credential }]) {
      const value = fixture() as any; value[part] = replacement; bad.push(value);
    }
  }
  for (const k of counterKeys) {
    const missing = fixture(); delete (missing.counters as any)[k]; bad.push(missing);
    for (const field of ['used', 'limit', 'remaining']) {
      const value = fixture() as any; delete value.counters[k][field]; bad.push(value);
    }
    for (const replacement of [null, [], {}, { used: 1, limit: 10 }, { used: 1, limit: 10, remaining: 9, principal: credential }]) {
      const value = fixture() as any; value.counters[k] = replacement; bad.push(value);
    }
  }
  for (const value of bad) await assert.rejects(client(async () => json(value)).getUsage(), protocol);
});

test('rejects fractional, negative, unsafe, nonnumeric and inconsistent counter fields', async () => {
  for (const k of counterKeys) for (const field of ['used', 'limit', 'remaining']) {
    for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '1', true]) {
      const value = fixture() as any; value.counters[k][field] = bad;
      await assert.rejects(client(async () => json(value)).getUsage(), protocol);
    }
  }
  for (const counter of [{ used: 1, limit: 10, remaining: 10 }, { used: 11, limit: 10, remaining: 1 }, { used: 0, limit: 0, remaining: 1 }]) {
    const value = fixture(); value.counters.liveReplays = counter;
    await assert.rejects(client(async () => json(value)).getUsage(), protocol);
  }
});

test('UTC calendar period includes start, excludes end, crosses year and leap month', async () => {
  for (const [asOf, start, end] of [
    ['2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'],
    ['2026-10-31T23:59:59.999999Z', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
    ['2026-12-31T23:59:59Z', '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z'],
    ['2028-02-29T23:59:59Z', '2028-02-01T00:00:00Z', '2028-03-01T00:00:00Z'],
  ]) {
    const value = { ...fixture(), asOf, period: { start, end } };
    assert.deepEqual(await client(async () => json(value)).getUsage(), value);
  }
});

test('rejects impossible dates, nonUTC instants and wrong monthly/asOf boundaries', async () => {
  const bad = [
    { asOf: '2026-11-01T00:00:00Z' }, { asOf: '2026-09-30T23:59:59Z' },
    ...['2026-10-18', '2026-10-18T12:00:00+01:00', '2026-10-18T12:00:00+00:00', '2026-10-18T24:00:00Z', '2026-10-18T12:60:00Z', credential].map(asOf => ({ asOf })),
    { asOf: '2026-02-30T12:00:00Z', period: { start: '2026-03-01T00:00:00Z', end: '2026-04-01T00:00:00Z' } },
    { asOf: '2027-02-29T12:00:00Z', period: { start: '2027-02-01T00:00:00Z', end: '2027-03-01T00:00:00Z' } },
    ...[
      { start: '2026-10-02T00:00:00Z', end: '2026-11-01T00:00:00Z' },
      { start: '2026-10-01T00:00:00Z', end: '2026-10-31T23:59:59Z' },
      { start: '2026-10-01T00:00:00Z', end: '2026-12-01T00:00:00Z' },
      { start: '2026-10-01T00:00:00.000001Z', end: '2026-11-01T00:00:00Z' },
    ].map(period => ({ period })),
  ];
  for (const value of bad) await assert.rejects(client(async () => json({ ...fixture(), ...value })).getUsage(), protocol);
});

test('401/403/409/503 preserve safe API codes/status but discard reflected server/cause/private fields', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'scope_denied'], [409, 'quota_exceeded'], [503, 'unavailable']] as const) {
    for (const reflected of [false, true]) {
      let calls = 0;
      await assert.rejects(client(async () => { calls++; return json({ error: { code: reflected ? credential : code, message: credential, cause: credential }, secret: credential }, status); }).getUsage(), e => {
        assert(e instanceof AvailKitError); assert.equal(e.kind, 'api'); assert.equal(e.status, status);
        assert.equal(e.code, reflected ? 'api_error' : code); assert.equal(e.cause, undefined);
        assert(!JSON.stringify(e).includes(credential)); assert(!String(e).includes(credential)); return true;
      });
      assert.equal(calls, 1);
    }
  }
  let calls = 0;
  await assert.rejects(client(async () => { calls++; throw new Error(credential); }).getUsage(), e => e instanceof AvailKitError && e.kind === 'transport' && e.cause === undefined && !String(e).includes(credential));
  assert.equal(calls, 1);
});

test('usage enforces JSON/status/no-store/redirect and response byte bounds', async () => {
  for (const response of [json(fixture(), 201), json(fixture(), 200, { 'Cache-Control': 'public' }), json(fixture(), 200, { 'Content-Type': 'text/plain' }), new Response('{', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })]) {
    await assert.rejects(client(async () => response).getUsage(), protocol);
  }
  const redirected = json(fixture()); Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(client(async () => redirected).getUsage(), protocol);
  const uncached = json(fixture()); uncached.headers.delete('cache-control');
  await assert.rejects(client(async () => uncached).getUsage(), protocol);
  await assert.rejects(client(async () => json(fixture()), { maxResponseBytes: 20 }).getUsage(), e => e instanceof AvailKitError && e.code === 'response_too_large');
});

test('usage bounds fetch and body waits, aborts/cancels and never retries', async () => {
  for (const bodyWait of [false, true]) {
    let calls = 0, cancelled = false; let signal: AbortSignal;
    const c = client(async (_, init) => {
      calls++; signal = init.signal as AbortSignal;
      if (!bodyWait) return new Promise<Response>(resolve => signal.addEventListener('abort', () => resolve(json(fixture())), { once: true }));
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }, { timeoutMs: 10 });
    await assert.rejects(c.getUsage(), e => e instanceof AvailKitError && e.code === 'timeout');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal!.aborted, true); assert.equal(calls, 1);
    if (bodyWait) assert.equal(cancelled, true);
  }
});

test('CLI usage emits exact validated counters, accepts only env credentials and no extra args', async () => {
  const previous = globalThis.fetch;
  try {
    let calls = 0, output = '';
    globalThis.fetch = async (url, init) => {
      calls++; assert.equal(String(url), 'http://127.0.0.1/v1/workspaces/ws%2Fone/usage');
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${credential}`); return json(fixture());
    };
    await runCli(['usage'], env, text => { output += text; });
    assert.deepEqual(JSON.parse(output), fixture()); assert(!output.includes(credential));
    await assert.rejects(runCli(['usage', credential], env, () => {}), AvailKitError);
    for (const name of Object.keys(env)) {
      const missing = { ...env }; delete (missing as any)[name];
      await assert.rejects(runCli(['usage'], missing, () => {}), AvailKitError);
    }
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test('CLI help distinguishes month/retained/individual expiry semantics without delivery success claims', async () => {
  assert.match(help, /\n  usage\n/); assert.match(help, /Only monthly booking creates reset monthly/);
  assert.match(help, /Cancelled bookings, committed events, disabled subscriptions and terminal delivery\nrows remain retained/);
  assert.match(help, /expire individually after 24 hours/); assert.match(help, /advisory, not a reservation/);
  let output = ''; await runCli(['--help'], {}, s => { output += s; }); assert.equal(output, help + '\n');
});

test('real CLI entrypoint redacts reflected errors and joins mock-only child without filesystem or HTTP', async () => {
  const cli = new URL('../src/cli.mts', import.meta.url);
  for (const status of [200, 401, 403, 409, 503]) {
    const value = status === 200 ? { ...fixture(), payload: credential } : { error: { code: credential, message: credential } };
    const script = `globalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify(value))},{status:${status},headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}); process.argv=[process.execPath,${JSON.stringify(cli.pathname)},'usage']; await import(${JSON.stringify(cli.href)});`;
    const child = spawn(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(exit, 1); assert.equal(out, ''); assert(!err.includes(credential));
    assert.match(err, /no automatic retry was sent/); assert(!err.includes('payload')); assert(!err.includes('cause'));
  }
});
