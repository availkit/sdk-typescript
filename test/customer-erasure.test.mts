import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AvailKitClient, AvailKitError } from '../src/index.ts';
import type { Fetch } from '../src/index.ts';
import { runCli, customerErasureFailure } from '../src/cli.mts';
import { exportCustomers } from '../src/customer-export.mts';

const id = 'a'.repeat(32), other = 'b'.repeat(32), credential = 'synthetic-erasure-credential';
const env = { AVAILKIT_BASE_URL: 'http://127.0.0.1', AVAILKIT_WORKSPACE_ID: 'ws', AVAILKIT_CREDENTIAL: credential };
const ordinary = { id, displayName: 'Synthetic M22 contact', email: 'm22@example.invalid', phone: null, archived: false };
const tombstone = { id, displayName: 'Erased customer', email: null, phone: null, archived: true, erased: true };
const json = (x: unknown, status = 200, cache = 'no-store') => new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': cache } });
const client = (fetch: Fetch) => new AvailKitClient({ baseUrl: env.AVAILKIT_BASE_URL, workspaceId: 'ws', credential, fetch });
const protocol = (e: unknown) => e instanceof AvailKitError && e.kind === 'protocol';

test('M22 SDK erase sends one scoped closed keyless request and accepts only its exact summary', async () => {
  let calls = 0;
  const c = client(async (url, init) => {
    calls++; assert.equal(url, `${env.AVAILKIT_BASE_URL}/v1/workspaces/ws/customers/${id}/erase`);
    assert.equal(init.method, 'POST'); assert.equal(init.body, '{}');
    const headers = new Headers(init.headers); assert.equal(headers.get('Authorization'), `Bearer ${credential}`);
    assert.equal(headers.has('Idempotency-Key'), false); assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    return json({ id, erased: true });
  });
  assert.deepEqual(await c.eraseCustomer(id), { id, erased: true }); assert.equal(calls, 1);
  for (const invalid of ['', ordinary.email, 'A'.repeat(32)]) assert.throws(() => c.eraseCustomer(invalid), AvailKitError);
  assert.equal(calls, 1);
  for (const value of [{ id: other, erased: true }, { id, erased: false }, tombstone, { id }, { id, erased: true, email: ordinary.email }]) {
    await assert.rejects(client(async () => json(value)).eraseCustomer(id), protocol);
  }
  await assert.rejects(client(async () => json({ id, erased: true }, 200, 'public')).eraseCustomer(id), protocol);
});

test('M22 customer decoding preserves ordinary shape and enforces every optional tombstone invariant', async () => {
  assert.deepEqual(await client(async () => json(ordinary)).getCustomer(id), ordinary);
  assert.equal(Object.hasOwn(await client(async () => json(ordinary)).getCustomer(id), 'erased'), false);
  assert.deepEqual(await client(async () => json(tombstone)).getCustomer(id), tombstone);
  assert.deepEqual((await client(async () => json({ items: [tombstone], nextAfter: null })).listCustomers()).items, [tombstone]);
  for (const bad of [{ ...ordinary, erased: false }, { ...ordinary, erased: true }, { ...tombstone, email: ordinary.email },
    { ...tombstone, phone: '555' }, { ...tombstone, displayName: 'Other' }, { ...tombstone, archived: false }, { ...tombstone, extra: true }]) {
    await assert.rejects(client(async () => json(bad)).getCustomer(id), protocol);
    await assert.rejects(client(async () => json({ items: [bad], nextAfter: null })).listCustomers(), protocol);
  }
  let sends = 0;
  const c = client(async () => { sends++; return json(tombstone); });
  assert.throws(() => c.createCustomer({ ...ordinary, erased: true }), AvailKitError); assert.equal(sends, 0);
});

test('M22 erasure refusals and uncertain errors stay fixed and nonreflecting without retry', async () => {
  for (const [status, code, unknown] of [[400, 'invalid_input', false], [401, 'credential_invalid', false],
    [403, 'capability_denied', false], [403, 'scope_denied', false], [404, 'not_found', false],
    [409, 'customer_archived', true], [403, ordinary.email, true], [503, 'unavailable', true]] as const) {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return json({ error: { code, message: ordinary.email } }, status); }).eraseCustomer(id), e => {
      const message = customerErasureFailure(e); assert.equal(message.includes('outcome is unknown'), unknown);
      assert(!message.includes(ordinary.email)); assert(!message.includes(credential)); assert(!message.includes(id)); return true;
    });
    assert.equal(calls, 1);
  }
  for (const mode of ['transport', 'protocol']) {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; if (mode === 'transport') throw new Error(ordinary.email); return json({ id, erased: false }); }).eraseCustomer(id), e => {
      assert.match(customerErasureFailure(e), /outcome is unknown/); return true;
    }); assert.equal(calls, 1);
  }
});

test('M22 CLI requires fresh literal confirmation before any send and outputs only the summary', async () => {
  const original = globalThis.fetch; let calls = 0; let output = '';
  try {
    globalThis.fetch = async () => { calls++; return json({ id, erased: true }); };
    for (const args of [[id], [id, '--yes'], ['--confirm', id], [id, '--confirm', '--confirm'], [ordinary.email, '--confirm']]) {
      await assert.rejects(runCli(['customers-erase', ...args], env, () => assert.fail('invalid command printed output')));
    }
    assert.equal(calls, 0);
    await runCli(['customers-erase', id, '--confirm'], env, text => { output += text; });
    assert.equal(calls, 1); assert.equal(output, JSON.stringify({ id, erased: true }) + '\n');
    // A second call is a separately confirmed manual request, never implicit retry.
    await runCli(['customers-erase', id, '--confirm'], env, () => {}); assert.equal(calls, 2);
    await assert.rejects(runCli(['customers-erase', id, '--confirm'], { ...env, AVAILKIT_CREDENTIAL: id }, () => assert.fail('credential reflected')));
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test('M22 actual CLI children join success, refusal, unknown and missing confirmation without reflection', async () => {
  for (const [mode, exit, calls] of [['success', 0, 1], ['refusal', 1, 1], ['unknown', 1, 1], ['protocol', 1, 1], ['unconfirmed', 1, 0]] as const) {
    const script = `
      let calls = 0;
      globalThis.fetch = async (_url, init) => {
        calls++;
        if (init.method !== 'POST' || init.body !== '{}' || new Headers(init.headers).has('Idempotency-Key')) throw new Error('bad request');
        const mode = ${JSON.stringify(mode)};
        const status = mode === 'refusal' ? 403 : mode === 'unknown' ? 503 : 200;
        const data = status !== 200 ? {error:{code:status === 403 ? 'capability_denied' : 'unavailable',message:${JSON.stringify(ordinary.email)}}}
          : {id:${JSON.stringify(id)},erased:mode !== 'protocol'};
        return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
      };
      process.argv = [process.execPath, new URL('./src/cli.mts', import.meta.url).pathname,'customers-erase',${JSON.stringify(id)},...(${JSON.stringify(mode)} === 'unconfirmed' ? [] : ['--confirm'])];
      process.on('exit', () => { if(calls !== ${calls}) process.exitCode = 99; });
      await import('./src/cli.mts');
    `;
    const child = spawn(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', script], { cwd: new URL('../', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, exit, mode); assert(!out.includes(ordinary.email)); assert(!err.includes(ordinary.email)); assert(!out.includes(credential)); assert(!err.includes(credential));
    if (mode === 'success') { assert.equal(out, JSON.stringify({ id, erased: true }) + '\n'); assert.equal(err, ''); }
    else { assert.equal(out, ''); assert.equal(err.includes('outcome is unknown'), mode === 'unknown' || mode === 'protocol'); }
  }
});

test('M22 erased contact export keeps exact schemaVersion1 five-field private file projection', async () => {
  const root = await mkdtemp(join(process.env.AVAILKIT_TEST_TMP ?? tmpdir(), '.m22-export-'));
  const path = join(root, 'contacts.jsonl'); let calls = 0;
  const summary = await exportCustomers(path, { baseUrl: env.AVAILKIT_BASE_URL, workspaceId: 'ws', credential }, {
    fetch: async () => { calls++; return json({ items: [tombstone], nextAfter: null }); },
  });
  const bytes = await readFile(path, 'utf8'), lines = bytes.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(calls, 1); assert.equal(summary.records, 1); assert.equal(summary.bytes, Buffer.byteLength(bytes));
  assert.equal(lines[0].data.schemaVersion, 1);
  assert.deepEqual(lines[1], { type: 'customer', data: { id, displayName: 'Erased customer', email: null, phone: null, archived: true } });
  assert.equal(Object.keys(lines[1].data).length, 5); assert.equal(bytes.includes('"erased"'), false);
  assert(!bytes.includes(credential)); assert(!bytes.includes(ordinary.email)); assert.equal((await stat(path)).mode & 0o777, 0o600);
});
