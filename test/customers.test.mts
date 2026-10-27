import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AvailKitClient, AvailKitError } from '../src/index.ts';
import type { CustomerInput, Fetch } from '../src/index.ts';
import { runCli, customerFailure } from '../src/cli.mts';
const id = 'a'.repeat(32), other = 'b'.repeat(32), credential = 'synthetic-customer-access';
const contact = { displayName: 'Synthetic contact', email: 'person@example.invalid', phone: '+1 555 0100' };
const customer = () => ({ id, ...contact, archived: false });
const env = { AVAILKIT_BASE_URL: 'http://127.0.0.1', AVAILKIT_WORKSPACE_ID: 'ws', AVAILKIT_CREDENTIAL: credential };
const json = (x: unknown, status = 200, cache = 'no-store') => new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': cache } });
const client = (fetch: Fetch, timeoutMs = 1000) => new AvailKitClient({ baseUrl: env.AVAILKIT_BASE_URL, workspaceId: 'ws', credential, fetch, timeoutMs });
const protocol = (e: unknown) => e instanceof AvailKitError && e.kind === 'protocol';

test('customers SDK routes are scoped, send once, no-store and keyless; PUT omissions clear contacts', async () => {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  const c = client(async (url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init.method, body });
    const h = new Headers(init.headers); assert.equal(h.get('Authorization'), `Bearer ${credential}`); assert.equal(h.has('Idempotency-Key'), false);
    assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    return json(url.includes('?') ? { items: [customer()], nextAfter: id } : init.method === 'PUT' ? { ...customer(), email: null, phone: null } : { ...customer(), archived: url.endsWith('/archive') }, init.method === 'POST' && url.endsWith('/customers') ? 201 : 200);
  });
  await c.createCustomer(contact); await c.listCustomers({ limit: 1 }); await c.getCustomer(id); await c.replaceCustomer(id, { displayName: contact.displayName }); await c.archiveCustomer(id);
  assert.deepEqual(calls.map(x => [x.method, x.url.replace(env.AVAILKIT_BASE_URL, '')]), [['POST', '/v1/workspaces/ws/customers'], ['GET', '/v1/workspaces/ws/customers?limit=1'], ['GET', `/v1/workspaces/ws/customers/${id}`], ['PUT', `/v1/workspaces/ws/customers/${id}`], ['POST', `/v1/workspaces/ws/customers/${id}/archive`]]);
  assert.deepEqual(calls[3].body, { displayName: contact.displayName }); assert.deepEqual(calls[4].body, {});
});
test('customer inputs reject closed-shape, size, control, email and opaque ID violations before send', () => {
  let calls = 0; const c = client(async () => { calls++; return json(customer()); });
  for (const body of [null, [], {}, { ...contact, extra: 'private' }, { ...contact, displayName: ' ' }, { ...contact, displayName: 'x'.repeat(161) }, { ...contact, email: 'bad@@example.invalid' }, { ...contact, phone: '' }, { ...contact, phone: 'x'.repeat(33) }, { ...contact, phone: 'x\ny' }, { ...contact, email: undefined }]) {
    assert.throws(() => c.createCustomer(body as CustomerInput), e => e instanceof AvailKitError && e.kind === 'input' && !String(e).includes(contact.email));
  }
  for (const bad of ['', '../x', 'A'.repeat(32), 'person@example.invalid']) {
    assert.throws(() => c.getCustomer(bad), AvailKitError); assert.throws(() => c.archiveCustomer(bad), AvailKitError); assert.throws(() => c.listCustomers({ after: bad }), AvailKitError);
  }
  assert.equal(calls, 0);
});
test('customer response validation refuses contacts outside the closed contract and identity mismatches', async () => {
  for (const bad of [{ ...customer(), extra: 'private' }, { ...customer(), id: other }, { ...customer(), archived: 'false' }, { ...customer(), email: 'bad' }, { ...customer(), phone: '\t' }, { ...customer(), phone: undefined }]) {
    await assert.rejects(client(async () => json(bad)).getCustomer(id), protocol);
  }
  await assert.rejects(client(async () => json(customer(), 200, 'public')).getCustomer(id), protocol);
  await assert.rejects(client(async () => json({ ...customer(), displayName: 'different' }, 201)).createCustomer(contact), protocol);
  await assert.rejects(client(async () => json(customer())).archiveCustomer(id), protocol);
});
test('customer pages include archived contacts but enforce closed pagination and advancing opaque cursors', async () => {
  const archived = { ...customer(), archived: true };
  assert.deepEqual((await client(async () => json({ items: [archived], nextAfter: null })).listCustomers()).items, [archived]);
  for (const bad of [{ items: [customer()], nextAfter: other }, { items: [customer(), customer()], nextAfter: null }, { items: [], nextAfter: id }, { items: [], nextAfter: null, email: contact.email }]) await assert.rejects(client(async () => json(bad)).listCustomers(), protocol);
});
test('customer errors never reflect server text or arbitrary codes; documented codes survive', async () => {
  for (const code of [contact.email, 'customer_archived', 'capability_denied']) {
    await assert.rejects(client(async () => json({ error: { code, message: contact.phone } }, 409)).archiveCustomer(id), e => {
      assert(e instanceof AvailKitError); assert.equal(e.code, code === contact.email ? 'api_error' : code); assert(!JSON.stringify(e).includes(contact.email)); assert(!String(e).includes(contact.phone)); return true;
    });
  }
});
test('customer writes snapshot input, never auto-retry and classify transport/503/protocol as unknown', async () => {
  for (const mode of ['transport', '503', 'protocol', 'timeout']) {
    let calls = 0;
    const c = client(async (_url, init) => { calls++; assert.deepEqual(JSON.parse(String(init.body)), contact);
      if (mode === 'transport') throw new Error(contact.email);
      if (mode === 'timeout') return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return mode === '503' ? json({ error: { code: 'unavailable', message: contact.email } }, 503) : json({ invalid: true }, 201);
    }, 10);
    const draft = { ...contact }, sent = c.createCustomer(draft); draft.email = 'changed@example.invalid';
    await assert.rejects(sent, e => { assert.match(customerFailure(e, true), /outcome is unknown/); assert(!customerFailure(e, true).includes(contact.email)); return true; }); assert.equal(calls, 1);
  }
});
test('linked booking create/read/list/cancel/reschedule validate opaque link and preserve unchanged unlinked shape', async () => {
  const base = { id: 'booking', offeringId: 'offering', resourceId: 'resource', start: '2030-01-07T09:00:00Z', end: '2030-01-07T09:30:00Z', status: 'confirmed' };
  for (const link of [undefined, id]) {
    const row = { ...base, ...(link ? { customerId: link } : {}) };
    const c = client(async (url) => json(url.includes('?') ? { items: [row], nextAfter: null } : url.endsWith('/cancel') ? { ...row, status: 'cancelled' } : row, url.endsWith('/bookings') ? 201 : 200));
    assert.deepEqual(await c.book({ offeringId: base.offeringId, start: base.start, ...(link ? { customerId: link } : {}) }, 'synthetic-link-key'), row);
    assert.deepEqual(await c.getBooking('booking'), row); assert.deepEqual((await c.listBookings({ limit: 1 })).items, [row]);
    assert.equal((await c.cancel('booking', 'synthetic-cancel-key')).customerId, link);
    assert.equal((await c.rescheduleBooking('booking', { expectedStart: base.start, start: base.start }, 'synthetic-resched-key')).customerId, link);
  }
  for (const bad of [null, '', 'person@example.invalid', 'A'.repeat(32)]) {
    const c = client(async () => json({ ...base, customerId: bad }));
    assert.throws(() => c.book({ offeringId: 'offering', start: base.start, customerId: bad as string }, 'synthetic-link-key'), AvailKitError);
    await assert.rejects(c.getBooking('booking'), protocol);
    await assert.rejects(c.rescheduleBooking('booking', { expectedStart: base.start, start: base.start }, 'synthetic-resched-key'), protocol);
  }
});
test('customer CLI dispatches all five operations and prints contacts only as intentional results', async () => {
  const root = await mkdtemp(join(process.env.AVAILKIT_TEST_TMP ?? tmpdir(), '.customer-cli-'));
  const path = join(root, 'input.json'); await writeFile(path, JSON.stringify(contact), { mode: 0o600 });
  const original = globalThis.fetch; const calls: { method?: string; body: unknown }[] = []; let output = '';
  try {
    globalThis.fetch = async (_url, init) => { calls.push({ method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined }); return json(String(_url).includes('?') ? { items: [customer()], nextAfter: null } : { ...customer(), archived: String(_url).endsWith('/archive') }, init?.method === 'POST' && String(_url).endsWith('/customers') ? 201 : 200); };
    for (const args of [['create', path], ['list', '-', '25'], ['get', id], ['replace', id, path], ['archive', id]]) await runCli(['customer', ...args], env, text => { output += text; });
    assert.equal(calls.length, 5); assert.deepEqual(calls.map(x => x.method), ['POST', 'GET', 'GET', 'PUT', 'POST']); assert(output.includes(contact.email)); assert(!output.includes(credential));
    for (const args of [['create'], ['get', contact.email], ['list', '-', '0'], ['archive', id, 'extra'], ['unknown']]) await assert.rejects(runCli(['customer', ...args], env, () => {}));
    assert.equal(calls.length, 5);
  } finally { globalThis.fetch = original; }
});
test('customer CLI fixed diagnostics distinguish rejection from uncertainty without contacts', () => {
  assert.doesNotMatch(customerFailure(new AvailKitError('api', 'customer_archived', 409), true), /unknown/);
  for (const e of [new Error(contact.email), new AvailKitError('api', contact.email, 409), new AvailKitError('protocol', 'invalid_response', 201), new AvailKitError('transport', 'deadline')]) {
    const message = customerFailure(e, true); assert.match(message, /outcome is unknown/); assert(!message.includes(contact.email)); assert.match(message, /Pause customer writes/);
  }
});

test('customer executable CLI joins keyless single-send failure with fixed unknown-outcome stderr', async () => {
  const script = `
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: 'person@example.invalid', message: 'person@example.invalid' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }); };
    process.argv = [process.execPath, new URL('./src/cli.mts', import.meta.url).pathname, 'customer', 'archive', '${id}'];
    process.on('exit', () => { if (calls !== 1) process.exitCode = 99; });
    await import('./src/cli.mts');
  `;
  const child = spawn(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', script], { cwd: new URL('../', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(exit, 1); assert.equal(out, ''); assert.match(err, /outcome is unknown/); assert.match(err, /Pause customer writes/); assert(!err.includes(contact.email)); assert(!err.includes(credential));
});
