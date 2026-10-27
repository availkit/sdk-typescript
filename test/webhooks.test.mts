import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bookAndObserve } from '../scenarios/m4/observe.ts';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AvailKitClient, AvailKitError } from '../src/index.ts';
import type { Fetch, WebhookDelivery } from '../src/index.ts';
import { runCli } from '../src/cli.mts';

const id = (n: number) => n.toString(16).padStart(32, '0');
const credential = 'synthetic-webhook-credential';
const secret = 'S'.repeat(43);
const now = '2030-01-07T09:00:00.000Z';
const subscription = { id: id(10), url: 'https://hooks.example.com/bookings', enabled: true, createdAt: now };
const created = { ...subscription, signingSecret: secret };
const delivery: WebhookDelivery = { id: id(20), subscriptionId: subscription.id, eventId: id(30), state: 'pending', createdAt: now, attempts: 0, maxAttempts: 5, nextAttemptAt: null, leaseExpiresAt: null, lastAttemptAt: null, lastOutcome: null, lastHttpStatus: null };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const client = (fetch: Fetch, extra = {}) => new AvailKitClient({ baseUrl: 'http://127.0.0.1', workspaceId: 'ws/one', credential, fetch, ...extra });
const protocol = (e: unknown) => e instanceof AvailKitError && e.kind === 'protocol';

test('four webhook methods use exact routes, payloads, statuses and shared workspace authority', async () => {
  const seen: { url: URL; init: RequestInit }[] = [];
  const replies = [json(created, 201), json({ items: [subscription], nextAfter: subscription.id }), json({ ...subscription, enabled: false }), json({ items: [delivery], nextAfter: null })];
  const c = client(async (url, init) => { seen.push({ url: new URL(url), init }); return replies.shift()!; });
  assert.deepEqual(await c.createWebhook({ url: subscription.url }), created);
  await c.listWebhooks({ after: id(1), limit: 1 });
  assert.equal((await c.disableWebhook(subscription.id)).enabled, false);
  assert.deepEqual(await c.listWebhookDeliveries(subscription.id), { items: [delivery], nextAfter: null });
  assert.deepEqual(seen.map(x => [x.init.method, x.url.pathname + x.url.search]), [
    ['POST', '/v1/workspaces/ws%2Fone/webhooks'],
    ['GET', `/v1/workspaces/ws%2Fone/webhooks?after=${id(1)}&limit=1`],
    ['POST', `/v1/workspaces/ws%2Fone/webhooks/${subscription.id}/disable`],
    ['GET', `/v1/workspaces/ws%2Fone/webhooks/${subscription.id}/deliveries`],
  ]);
  assert.equal(seen[0].init.body, JSON.stringify({ url: subscription.url }));
  assert.equal(seen[1].init.body, undefined); assert.equal(seen[2].init.body, '{}'); assert.equal(seen[3].init.body, undefined);
  for (const { init } of seen) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${credential}`);
    assert.equal(headers.get('Idempotency-Key'), null);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
  }
});

test('MANAGE/READ failures, foreign scopes/cursors and quota errors remain one-send redacted errors', async () => {
  const operations = [c => c.createWebhook({ url: subscription.url }), c => c.listWebhooks(), c => c.disableWebhook(subscription.id), c => c.listWebhookDeliveries(subscription.id)] as ((c: AvailKitClient) => Promise<unknown>)[];
  for (const action of operations) for (const [status, code] of [[401, 'unauthorized'], [403, 'scope_denied'], [404, 'not_found'], [409, 'quota_exceeded'], [503, 'unavailable']] as const) {
    let calls = 0;
    await assert.rejects(action(client(async () => { calls++; return json({ error: { code, message: secret + credential } }, status); })), e => {
      assert(e instanceof AvailKitError); assert.equal(e.kind, 'api'); assert.equal(e.status, status); assert.equal(e.code, code);
      assert(!JSON.stringify(e).includes(secret)); assert(!String(e).includes(credential)); return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(client(async () => json({ error: { code: secret, message: credential } }, 503)).createWebhook({ url: subscription.url }), e => e instanceof AvailKitError && e.code === 'api_error' && !JSON.stringify(e).includes(secret));
});

test('invalid ID/query/body bounds reject before sending and create snapshots its body', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return json(created, 201); });
  for (const bad of ['', '..', 'a'.repeat(31), 'A'.repeat(32), 'a'.repeat(33), 'a/b']) {
    assert.throws(() => c.disableWebhook(bad), AvailKitError);
    assert.throws(() => c.listWebhookDeliveries(bad), AvailKitError);
    assert.throws(() => c.listWebhooks({ after: bad }), AvailKitError);
    assert.throws(() => c.listWebhookDeliveries(subscription.id, { after: bad }), AvailKitError);
  }
  for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: NaN }, { extra: true }]) {
    assert.throws(() => c.listWebhooks(query as never), AvailKitError);
    assert.throws(() => c.listWebhookDeliveries(subscription.id, query as never), AvailKitError);
  }
  for (const body of [{}, { url: '' }, { url: 'x'.repeat(2049) }, { url: 'é' }, { url: subscription.url, extra: secret }]) assert.throws(() => c.createWebhook(body as never), AvailKitError);
  assert.equal(calls, 0);
  const body = { url: subscription.url };
  const pending = client(async (_, init) => { await Promise.resolve(); assert.equal(init.body, JSON.stringify({ url: subscription.url })); return json(created, 201); }).createWebhook(body);
  body.url = 'https://different.example.com/'; await pending;
});

test('pages validate default25/max100 bounds, order, advancing cursors, exact schema and query snapshot', async () => {
  for (const data of [
    { items: [subscription, subscription], nextAfter: null },
    { items: [{ ...subscription, id: id(11) }, subscription], nextAfter: null },
    { items: [subscription], nextAfter: subscription.id }, // short default page cannot continue
    { items: [], nextAfter: id(1) }, { items: [], nextAfter: 3 }, { items: [] },
    { items: [], nextAfter: null, signingSecret: secret },
    { items: [{ ...subscription, signingSecret: secret }], nextAfter: null },
    { items: [{ ...subscription, id: 'invalid' }], nextAfter: null },
    { items: Array.from({ length: 26 }, (_, i) => ({ ...subscription, id: id(i + 1) })), nextAfter: null },
  ]) await assert.rejects(client(async () => json(data)).listWebhooks(), protocol);
  await assert.rejects(client(async () => json({ items: [subscription], nextAfter: null })).listWebhooks({ after: subscription.id }), protocol);
  await assert.rejects(client(async () => json({ items: [subscription, { ...subscription, id: id(11) }], nextAfter: null })).listWebhooks({ limit: 1 }), protocol);
  const full = Array.from({ length: 100 }, (_, i) => ({ ...subscription, id: id(i + 1) }));
  assert.equal((await client(async () => json({ items: full, nextAfter: id(100) })).listWebhooks({ limit: 100 })).items.length, 100);
  const query = { limit: 1 };
  const pending = client(async () => { await Promise.resolve(); return json({ items: [subscription], nextAfter: subscription.id }); }).listWebhooks(query);
  query.limit = 100; assert.equal((await pending).nextAfter, subscription.id);
});

test('M4 status preserves all six states, finite outcomes and unknown admission without claiming success', async () => {
  for (const state of ['pending', 'suppressed', 'leased', 'sending', 'delivered', 'dead']) {
    const row = { ...delivery, state, attempts: 1, lastOutcome: 'admitted_unknown', lastAttemptAt: now, leaseExpiresAt: now };
    assert.deepEqual((await client(async () => json({ items: [row], nextAfter: null })).listWebhookDeliveries(subscription.id)).items[0], row);
  }
  for (const outcome of [null, 'admitted_unknown', 'claim_expired', 'lease_expired_unknown', 'disabled_unknown', 'not_attempted', 'invalid_target', 'invalid_delivery', 'address_denied', 'transport_unknown', 'deadline_unknown', 'http_drained', 'http_body_failed', 'http_body_deadline', 'http_body_too_large']) {
    const row = { ...delivery, attempts: 5, lastOutcome: outcome, nextAttemptAt: now, lastAttemptAt: now, lastHttpStatus: 599 };
    assert.deepEqual((await client(async () => json({ items: [row], nextAfter: null })).listWebhookDeliveries(subscription.id)).items[0], row);
  }
});

test('malformed status, foreign subscription, missing fields and private field injection are rejected', async () => {
  const mutations = [
    { id: 'x' }, { subscriptionId: id(99) }, { eventId: 'x' }, { state: 'queued' }, { attempts: -1 }, { attempts: 6 }, { attempts: 1.5 },
    { maxAttempts: 6 }, { nextAttemptAt: 'later' }, { leaseExpiresAt: 1 }, { lastAttemptAt: undefined }, { lastOutcome: 'success' },
    { lastHttpStatus: 99 }, { lastHttpStatus: 600 }, { lastHttpStatus: 200.5 }, { createdAt: '' },
    ...['payload', 'leaseToken', 'signingSecret', 'signature', 'key', 'rawError'].map(k => ({ [k]: secret })),
  ];
  for (const mutation of mutations) await assert.rejects(client(async () => json({ items: [{ ...delivery, ...mutation }], nextAfter: null })).listWebhookDeliveries(subscription.id), protocol);
  for (const data of [{ ...subscription, enabled: true }, { ...subscription, id: id(99), enabled: false }, { ...subscription, enabled: false, signingSecret: secret }]) await assert.rejects(client(async () => json(data)).disableWebhook(subscription.id), protocol);
  for (const signingSecret of ['', 'x'.repeat(42), 'x'.repeat(44), '!'.repeat(43)]) await assert.rejects(client(async () => json({ ...created, signingSecret }, 201)).createWebhook({ url: subscription.url }), protocol);
});

test('webhook timeout, oversize, wrong status/media and unknown create send only once', { timeout: 2000 }, async () => {
  for (const response of [json(created, 200), new Response(secret, { status: 201 }), json({ ...created, payload: secret }, 201)]) {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return response; }).createWebhook({ url: subscription.url }), protocol);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(client(async () => { calls++; throw new Error(secret); }).createWebhook({ url: subscription.url }), e => e instanceof AvailKitError && e.kind === 'transport' && !JSON.stringify(e).includes(secret));
  assert.equal(calls, 1);
  await assert.rejects(client(async () => json(created, 201), { maxResponseBytes: 8 }).createWebhook({ url: subscription.url }), protocol);
  await assert.rejects(client(async () => new Promise(() => {}), { timeoutMs: 10 }).createWebhook({ url: subscription.url }), e => e instanceof AvailKitError && e.code === 'timeout');
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(client(async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }), { timeoutMs: 10 }).listWebhookDeliveries(subscription.id), e => e instanceof AvailKitError && e.code === 'timeout');
  assert(cancelled); assert(!stream.locked);
});

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void, action: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert(address && typeof address === 'object');
    await action({ AVAILKIT_BASE_URL: `http://127.0.0.1:${address.port}`, AVAILKIT_WORKSPACE_ID: 'ws', AVAILKIT_CREDENTIAL: credential });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}
async function directory() {
  const root = process.env.AVAILKIT_TEST_ROOT ?? '.local/webhook-fixtures';
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, 'cli-'));
}
async function cliProcess(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--max-old-space-size=96', new URL('../src/cli.mts', import.meta.url).pathname, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; if (stdout.length > 65536) child.kill(); });
  child.stderr.on('data', b => { stderr += b; if (stderr.length > 65536) child.kill(); });
  const timer = setTimeout(() => child.kill(), 3000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test('CLI create exclusively reserves0600 before send; syncs secret response before redacted success', { timeout: 4000 }, async () => {
  const dir = await directory(); const input = join(dir, 'input.json'); const output = join(dir, 'secret.json');
  await writeFile(input, JSON.stringify({ url: subscription.url }), { mode: 0o600 });
  let calls = 0;
  await fixture((req, res) => {
    calls++; assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/workspaces/ws/webhooks');
    assert.equal(req.headers.authorization, `Bearer ${credential}`); assert.equal(req.headers['idempotency-key'], undefined);
    let bytes = ''; req.on('data', (b: Buffer) => { bytes += b; });
    req.on('end', async () => {
      assert.equal(bytes, JSON.stringify({ url: subscription.url }));
      assert.equal((await stat(output)).mode & 0o777, 0o600); assert.equal((await stat(output)).size, 0);
      res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...created, url: `https://hooks.example.com/${secret}/${credential}` }));
    });
  }, async env => {
    const result = await cliProcess(['webhook', 'create', input, output], env);
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert(!result.stdout.includes(secret)); assert(!result.stdout.includes(credential));
    assert.equal(JSON.parse(result.stdout).signingSecret, undefined); assert.equal(JSON.parse(result.stdout).secretSaved, true);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).signingSecret, secret);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(calls, 1);
    // The exclusive existing output prevents a second HTTP create, preserving its bytes.
    const before = await readFile(output, 'utf8');
    const repeated = await cliProcess(['webhook', 'create', input, output], env);
    assert.equal(repeated.code, 1); assert.equal(calls, 1); assert.equal(await readFile(output, 'utf8'), before);
    assert(!`${repeated.stdout}${repeated.stderr}`.includes(output));
  });
});

test('CLI refuses symlink/directory outputs and oversized/invalid input without HTTP', async () => {
  const dir = await directory(); const input = join(dir, 'input.json'); const target = join(dir, 'target'); const link = join(dir, 'link');
  await writeFile(input, JSON.stringify({ url: subscription.url }), { mode: 0o600 });
  await writeFile(target, 'preserve', { mode: 0o600 }); await symlink(target, link);
  let calls = 0;
  await fixture((_req, res) => { calls++; res.end(); }, async env => {
    for (const output of [link, dir, join(dir, 'missing', 'secret')]) await assert.rejects(runCli(['webhook', 'create', input, output], env, () => {}), e => e instanceof AvailKitError && e.code === 'secret_output_unavailable' && !String(e).includes(output));
    assert.equal(await readFile(target, 'utf8'), 'preserve');
    for (const bytes of ['{', 'x'.repeat(65537), Buffer.from([0xff])]) {
      await writeFile(input, bytes);
      await assert.rejects(runCli(['webhook', 'create', input, join(dir, 'unused')], env, () => {}), e => e instanceof AvailKitError && e.code === 'invalid_input_file');
    }
    assert.equal(calls, 0);
  });
});

test('CLI lost/unusable/known rejected create never retries, disables or prints secret/path/cause', { timeout: 6000 }, async () => {
  const dir = await directory(); const input = join(dir, 'input.json');
  await writeFile(input, JSON.stringify({ url: subscription.url }), { mode: 0o600 });
  for (const mode of ['lost', 'malformed', 'invalidSecret', 'forbidden', 'unavailable']) {
    let calls = 0;
    await fixture((req, res) => {
      calls++;
      if (mode === 'lost') { req.socket.destroy(); return; }
      res.writeHead(mode === 'forbidden' ? 403 : mode === 'unavailable' ? 503 : 201, { 'Content-Type': 'application/json' });
      res.end(mode === 'malformed' ? '{' : JSON.stringify(mode === 'invalidSecret' ? { ...created, signingSecret: secret + 'x' } : mode === 'forbidden' || mode === 'unavailable' ? { error: { code: secret, message: credential } } : created));
    }, async env => {
      const output = join(dir, mode);
      const result = await cliProcess(['webhook', 'create', input, output], env);
      assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(calls, 1);
      for (const value of [secret, credential, output, input]) assert(!result.stderr.includes(value));
      assert.match(result.stderr, /list subscriptions/); assert.match(result.stderr, /lost secret cannot be recovered/);
      assert.equal((await stat(output)).size, 0);
    });
  }
});

test('CLI persistence failure after create is unknown, closes file, retains private bytes and sends no compensating request', async () => {
  const dir = await directory(); const input = join(dir, 'input.json'); const output = join(dir, 'secret');
  await writeFile(input, JSON.stringify({ url: subscription.url }), { mode: 0o600 });
  const probe = await open(input); const proto = Object.getPrototypeOf(probe); await probe.close();
  const original = proto.sync; let calls = 0;
  await fixture((_req, res) => { calls++; res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(created)); }, async env => {
    proto.sync = async () => { throw new Error(secret + output); };
    try {
      await assert.rejects(runCli(['webhook', 'create', input, output], env, () => assert.fail('must not report success')), e => e instanceof AvailKitError && e.code === 'webhook_secret_persistence_unknown' && !JSON.stringify(e).includes(secret));
    } finally { proto.sync = original; }
    assert.equal(calls, 1); assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).signingSecret, secret);
  });
});

test('CLI list/disable/READ deliveries expose safe metadata, preserve unknown status and validate pagination', async () => {
  const seen: string[] = [];
  await fixture((req, res) => {
    seen.push(`${req.method} ${req.url}`); res.setHeader('Content-Type', 'application/json');
    if (req.url?.includes('/deliveries')) res.end(JSON.stringify({ items: [{ ...delivery, state: 'sending', attempts: 1, lastOutcome: 'admitted_unknown', lastAttemptAt: now, leaseExpiresAt: now }], nextAfter: null }));
    else if (req.url?.endsWith('/disable')) res.end(JSON.stringify({ ...subscription, enabled: false }));
    else res.end(JSON.stringify({ items: [subscription], nextAfter: subscription.id }));
  }, async env => {
    const results: any[] = [];
    for (const args of [['webhook', 'list', '-', '1'], ['webhook', 'disable', subscription.id], ['webhook', 'deliveries', subscription.id, id(1), '25']]) await runCli(args, env, text => results.push(JSON.parse(text)));
    assert.equal(results[1].enabled, false); assert.equal(results[2].items[0].state, 'sending'); assert.equal(results[2].items[0].lastOutcome, 'admitted_unknown');
    assert(!JSON.stringify(results).includes(secret));
    assert.deepEqual(seen, ['GET /v1/workspaces/ws/webhooks?limit=1', `POST /v1/workspaces/ws/webhooks/${subscription.id}/disable`, `GET /v1/workspaces/ws/webhooks/${subscription.id}/deliveries?after=${id(1)}&limit=25`]);
    for (const args of [['webhook', 'list', '-', '1e2'], ['webhook', 'list', '-', '101'], ['webhook', 'deliveries', subscription.id, id(1), '0'], ['webhook', 'retry', subscription.id]]) await assert.rejects(runCli(args, env, () => {}), AvailKitError);
    assert.equal(seen.length, 3);
  });
});


test('SDK example books once with stable intent and observes a subscription page without dispatch', async () => {
  const seen: { path: string; init: RequestInit }[] = [];
  const input = { offeringId: id(40), start: now };
  const c = client(async (url, init) => {
    seen.push({ path: new URL(url).pathname + new URL(url).search, init });
    return init.method === 'POST'
      ? json({ ...input, id: id(50), resourceId: id(60), end: '2030-01-07T09:30:00.000Z', status: 'confirmed' }, 201)
      : json({ items: [delivery], nextAfter: null });
  });
  const result = await bookAndObserve(c, subscription.id, input, 'synthetic-stable-intent');
  assert.equal(result.booking.status, 'confirmed'); assert.equal(result.deliveries.items[0].state, 'pending');
  assert.deepEqual(seen.map(x => x.path), ['/v1/workspaces/ws%2Fone/bookings', `/v1/workspaces/ws%2Fone/webhooks/${subscription.id}/deliveries?limit=25`]);
  assert.equal(new Headers(seen[0].init.headers).get('idempotency-key'), 'synthetic-stable-intent');
  assert.equal(seen[0].init.body, JSON.stringify(input));
});
