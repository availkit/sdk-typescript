import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { AvailKitClient, AvailKitError } from '../src/index.ts';
import type { Fetch } from '../src/index.ts';
import { runJourney } from '../scenarios/m1/journey.ts';
import { runCli } from '../src/cli.mts';

const from = '2030-01-07T09:00:00Z';
const end = '2030-01-07T09:30:00Z';
const to = '2030-01-08T09:00:00Z';
const credential = 'synthetic-fixture-only';
const intentKey = 'synthetic-booking-intent-1';
const resource = { id: 'res/one', name: 'Desk', timeZone: 'UTC', capacity: 1, archived: false };
const offering = { id: 'off-one', name: 'Consultation', resourceId: resource.id, durationMinutes: 30, archived: false };
const booked = { id: 'book-one', offeringId: offering.id, resourceId: resource.id, start: from, end, status: 'confirmed' };
const cancelled = { ...booked, status: 'cancelled' };
const windows = [{ weekday: 1, start: '09:00', end: '17:00' }];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const client = (fetch: Fetch, extra = {}) => new AvailKitClient({ baseUrl: 'http://127.0.0.1:43291', workspaceId: 'ws/one', credential, fetch, ...extra });
const apiFailure = (status: number, code: string) => (error: unknown) => error instanceof AvailKitError && error.kind === 'api' && error.status === status && error.code === code;

test('all seven methods use the shared M1 wire contract and explicit workspace authority', async () => {
  const seen: { url: URL; init: RequestInit }[] = [];
  const replies = [json(resource, 201), json({ windows }), json(offering, 201), json({ slots: [{ start: from, end, remainingCapacity: 1 }] }), json(booked, 201), json(cancelled), json({ events: [], nextAfter: 12, retentionFloor: 0, highWater: 12 })];
  const c = client(async (url, init) => { seen.push({ url: new URL(url), init }); return replies.shift()!; });
  await c.createResource({ name: 'Desk', timeZone: 'UTC', capacity: 1 });
  await c.replaceHours(resource.id, { windows });
  await c.createOffering({ name: offering.name, resourceId: resource.id, durationMinutes: 30 });
  await c.availability({ offeringId: offering.id, from, to });
  await c.book({ offeringId: offering.id, start: from }, intentKey);
  await c.cancel(booked.id, `${intentKey}:cancel`);
  await c.events({ after: 12, limit: 25 });
  assert.deepEqual(seen.map(x => [x.init.method, x.url.pathname]), [
    ['POST', '/v1/workspaces/ws%2Fone/resources'], ['PUT', '/v1/workspaces/ws%2Fone/resources/res%2Fone/hours'],
    ['POST', '/v1/workspaces/ws%2Fone/offerings'], ['GET', '/v1/workspaces/ws%2Fone/availability'],
    ['POST', '/v1/workspaces/ws%2Fone/bookings'], ['POST', '/v1/workspaces/ws%2Fone/bookings/book-one/cancel'],
    ['GET', '/v1/workspaces/ws%2Fone/events'],
  ]);
  assert.equal(seen[0].init.body, JSON.stringify({ name: 'Desk', timeZone: 'UTC', capacity: 1 }));
  assert.equal(seen[1].init.body, JSON.stringify({ windows }));
  assert.deepEqual(Object.fromEntries(seen[3].url.searchParams), { offeringId: offering.id, from, to });
  assert.equal(seen[3].init.body, undefined);
  assert.equal(seen[5].init.body, '{}');
  assert.equal(seen[6].url.search, '?after=12&limit=25');
  for (const { init } of seen) {
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${credential}`);
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
  }
  assert.equal(new Headers(seen[4].init.headers).get('idempotency-key'), intentKey);
  assert.equal(new Headers(seen[5].init.headers).get('idempotency-key'), `${intentKey}:cancel`);
});

test('lost-response retry is caller controlled and retains original intent/key', async () => {
  const calls: RequestInit[] = [];
  const c = client(async (_, init) => { calls.push(init); if (calls.length === 1) throw new Error(credential); return json(booked, 201); });
  const intent = { offeringId: offering.id, start: from };
  const original = { ...intent };
  const first = c.book(intent, intentKey);
  intent.start = to;
  await assert.rejects(first, error => error instanceof AvailKitError && error.kind === 'transport' && !String(error).includes(credential));
  assert.equal(calls.length, 1);
  await c.book(original, intentKey);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(new Headers(calls[0].headers).get('idempotency-key'), new Headers(calls[1].headers).get('idempotency-key'));
});

test('scope, missing-object, capacity, changed-intent and temporary errors remain structured', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'scope_denied'], [404, 'not_found'], [409, 'capacity_exceeded'], [409, 'idempotency_conflict'], [503, 'unavailable']] as const) {
    let calls = 0;
    const c = client(async () => { calls++; return json({ error: { code, message: credential } }, status); });
    await assert.rejects(c.book({ offeringId: offering.id, start: from }, intentKey), apiFailure(status, code));
    assert.equal(calls, 1);
  }
});

test('invalid status, body, media, UTF-8 and redirects fail as protocol errors', async () => {
  const responses = [json(resource), json({ wrong: true }, 201), new Response('<html>', { status: 201 }),
    new Response(Uint8Array.from([0xff]), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    new Response('{', { status: 201, headers: { 'Content-Type': 'application/json' } }), json({ error: 'oops' }, 403)];
  const redirected = json(resource, 201);
  Object.defineProperty(redirected, 'redirected', { value: true });
  responses.push(redirected);
  for (const response of responses) await assert.rejects(client(async () => response).createResource(resource), error => error instanceof AvailKitError && error.kind === 'protocol');
});

test('oversize body and stalled fetch/body have finite deadlines', { timeout: 2000 }, async () => {
  await assert.rejects(client(async () => json(resource, 201), { maxResponseBytes: 4 }).createResource(resource), error => error instanceof AvailKitError && error.code === 'response_too_large');
  await assert.rejects(client(async () => new Promise(() => {}), { timeoutMs: 20 }).createResource(resource), error => error instanceof AvailKitError && error.code === 'timeout');
  let streamCancelled = false;
  const stream = new ReadableStream({ start() {}, cancel() { streamCancelled = true; } });
  await assert.rejects(client(async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }), { timeoutMs: 20 }).events(), error => error instanceof AvailKitError && error.code === 'timeout');
  assert.equal(streamCancelled, true);
  assert.equal(stream.locked, false);
});

test('configuration, cursor, range and key boundaries reject before transport', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return json({}); });
  for (const action of [() => c.events({ limit: 101 }), () => c.events({ after: -1 }), () => c.availability({ offeringId: 'o', from, to: '2030-02-01T00:00:00Z' }), () => c.book({ offeringId: 'o', start: from }, ''), () => c.book({ offeringId: 'o', start: from }, 'short'), () => c.cancel('..', intentKey)]) assert.throws(action, AvailKitError);
  for (const options of [{ baseUrl: 'http://user:pass@localhost' }, { baseUrl: 'file:///tmp/a' }, { baseUrl: 'http://localhost/?x=1' }, { credential: 'bad\ncredential' }, { workspaceId: '..' }, { timeoutMs: 0 }]) assert.throws(() => client(async () => json({}), options), AvailKitError);
  assert.equal(calls, 0);
});

test('example configures and replays both transitions and receives two events', async () => {
  const sends: { path: string; init: RequestInit }[] = [];
  const c = client(async (url, init) => {
    const path = new URL(url).pathname;
    sends.push({ path, init });
    if (path.endsWith('/resources')) return json(resource, 201);
    if (path.endsWith('/hours')) return json(JSON.parse(String(init.body)));
    if (path.endsWith('/offerings')) return json(offering, 201);
    if (path.endsWith('/availability')) return json({ slots: [{ start: from, end, remainingCapacity: 1 }] });
    if (path.endsWith('/bookings')) return json(booked, 201);
    if (path.endsWith('/cancel')) return json(cancelled);
    if (new URL(url).searchParams.get('after') === '2') return json({ events: [], nextAfter: 2, retentionFloor: 0, highWater: 2 });
    return json({ events: [
      { id: 'e1', sequence: 1, type: 'booking.created', bookingId: booked.id, occurredAt: from },
      { id: 'e2', sequence: 2, type: 'booking.cancelled', bookingId: booked.id, occurredAt: end },
    ], nextAfter: 2, retentionFloor: 0, highWater: 2 });
  });
  const result = await runJourney(c, { from, to, intentKey });
  assert.equal(result.eventCount, 2);
  assert.equal(result.status, 'cancelled');
  const mutations = sends.filter(x => x.path.endsWith('/bookings') || x.path.endsWith('/cancel'));
  assert.equal(mutations[0].init.body, mutations[1].init.body);
  assert.equal(mutations[2].init.body, mutations[3].init.body);
});

test('event paging returns one explicit page without implicit traversal', async () => {
  const c = client(async () => json({ events: [], nextAfter: 5, retentionFloor: 0, highWater: 5 }));
  assert.equal((await c.events({ after: 5, limit: 1 })).nextAfter, 5);
  // The SDK returns one page and never walks the workspace implicitly.
});

test('real loopback fixture transports CLI events and redacts reflected credentials', { timeout: 3000 }, async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, '/v1/workspaces/ws/events?after=0&limit=1');
    assert.equal(req.headers.authorization, `Bearer ${credential}`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ events: [], nextAfter: 0, retentionFloor: 0, highWater: 0, extra: credential }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    let output = '';
    await runCli(['events', '0', '1'], { AVAILKIT_BASE_URL: `http://127.0.0.1:${address.port}`, AVAILKIT_WORKSPACE_ID: 'ws', AVAILKIT_CREDENTIAL: credential }, text => { output += text; });
    assert(!output.includes(credential));
    assert.deepEqual(JSON.parse(output), { events: [], nextAfter: 0, retentionFloor: 0, highWater: 0, extra: '[redacted]' });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('CLI help and configuration failures are bounded and do not echo credentials', () => {
  const executable = new URL('../src/cli.mts', import.meta.url);
  for (const args of [['--help'], ['events'], ['unknown', credential]]) {
    const result = spawnSync(process.execPath, [executable.pathname, ...args], { encoding: 'utf8', timeout: 2000, maxBuffer: 65536, env: { ...process.env, AVAILKIT_CREDENTIAL: credential, AVAILKIT_BASE_URL: '', AVAILKIT_WORKSPACE_ID: '' } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, args[0] === '--help' ? 0 : 1);
    assert(!`${result.stdout}${result.stderr}`.includes(credential));
  }
});

test('CLI booking retry reads the saved body/key and cancellation sends an empty object', { timeout: 3000 }, async () => {
  await mkdir('.local/m1-client-fixtures', { recursive: true, mode: 0o700 });
  const directory = await mkdtemp('.local/m1-client-fixtures/cli-');
  const file = `${directory}/booking.json`;
  const intent = { offeringId: offering.id, start: from };
  await writeFile(file, JSON.stringify(intent), { mode: 0o600, flag: 'wx' });
  const seen: { body: string; key: string | string[] | undefined; path: string | undefined }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ body, key: req.headers['idempotency-key'], path: req.url });
      if (seen.length === 1) { req.socket.destroy(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = req.url?.endsWith('/cancel') ? 200 : 201;
      res.end(JSON.stringify(req.url?.endsWith('/cancel') ? cancelled : booked));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const env = { AVAILKIT_BASE_URL: `http://127.0.0.1:${address.port}`, AVAILKIT_WORKSPACE_ID: 'ws', AVAILKIT_CREDENTIAL: credential };
    await assert.rejects(runCli(['book', file, intentKey], env, () => {}), error => error instanceof AvailKitError && error.kind === 'transport');
    assert.equal(seen.length, 1);
    await runCli(['book', file, intentKey], env, () => {});
    await runCli(['cancel', booked.id, `${intentKey}:cancel`], env, () => {});
    assert.deepEqual(seen[0], seen[1]);
    assert.equal(seen[0].body, JSON.stringify(intent));
    assert.equal(seen[2].body, '{}');
    assert.equal(seen[2].key, `${intentKey}:cancel`);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('journey saves immutable booking input before its first mutation and rejects stuck cursors', async () => {
  let saved = false;
  const c = client(async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/resources')) return json(resource, 201);
    if (path.endsWith('/hours')) return json(JSON.parse(String(init.body)));
    if (path.endsWith('/offerings')) return json(offering, 201);
    if (path.endsWith('/availability')) return json({ slots: [{ start: from, end, remainingCapacity: 1 }] });
    if (path.endsWith('/bookings')) { assert.equal(saved, true); return json(booked, 201); }
    if (path.endsWith('/cancel')) return json(cancelled);
    return json({ events: [{ id: 'e1', sequence: 1, type: 'booking.created', bookingId: booked.id, occurredAt: from }], nextAfter: 0, retentionFloor: 0, highWater: 0 });
  });
  await assert.rejects(runJourney(c, { from, to, intentKey, beforeBook: async intent => {
    assert(Object.isFrozen(intent));
    assert.deepEqual(intent, { offeringId: offering.id, start: from });
    saved = true;
  } }), e => e instanceof AvailKitError && e.code === 'invalid_response');
});

test('24:00 hours and numeric empty event cursor match Core contract', async () => {
  const c = client(async (url, init) => new URL(url).pathname.endsWith('/hours') ? json(JSON.parse(String(init.body))) : json({ events: [], nextAfter: 99, retentionFloor: 0, highWater: 99 }));
  assert.deepEqual(await c.replaceHours(resource.id, { windows: [{ weekday: 1, start: '23:00', end: '24:00' }] }), { windows: [{ weekday: 1, start: '23:00', end: '24:00' }] });
  assert.deepEqual(await c.events({ after: 99 }), { events: [], nextAfter: 99, retentionFloor: 0, highWater: 99 });
});
