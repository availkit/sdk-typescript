import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AvailKitClient, AvailKitError } from '../src/index.ts';
import type { Fetch, RescheduleInput } from '../src/index.ts';
import { runCli, help } from '../src/cli.mts';
import { runReschedule } from '../scenarios/m7/reschedule.ts';

const credential = 'synthetic-reschedule-credential';
const env = { AVAILKIT_BASE_URL: 'http://127.0.0.1', AVAILKIT_WORKSPACE_ID: 'ws/one', AVAILKIT_CREDENTIAL: credential };
const intent = (): RescheduleInput => ({ expectedStart: '2026-10-20T09:00:00Z', start: '2026-10-20T10:00:00Z' });
const moveKey = 'synthetic-move-intent';
const booking = () => ({ id: 'booking/one', offeringId: 'offering', resourceId: 'resource', start: intent().start, end: '2026-10-20T10:30:00Z', status: 'confirmed' });
const json = (data: unknown, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const client = (fetch: Fetch, extra = {}) => new AvailKitClient({ baseUrl: env.AVAILKIT_BASE_URL, workspaceId: env.AVAILKIT_WORKSPACE_ID, credential, fetch, ...extra });
const protocol = (e: unknown) => e instanceof AvailKitError && e.kind === 'protocol' && !JSON.stringify(e).includes(credential);
const plan = () => ({ book: { offeringId: 'offering', start: intent().expectedStart }, move: intent(), keys: { book: 'synthetic-book-intent', move: moveKey, cancel: 'synthetic-cancel-intent' } });
const temp = () => mkdtemp(join(process.env.AVAILKIT_TEST_TMP ?? process.cwd(), '.reschedule-test-'));
async function child(script: string, args: string[], extraEnv = {}) {
  const p = spawn(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', script, ...args], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', b => { out += b; }); p.stderr.on('data', b => { err += b; });
  const exit = await new Promise<number | null>((resolve, reject) => { p.once('error', reject); p.once('close', resolve); });
  assert(!out.includes(credential)); assert(!err.includes(credential));
  console.log(`joined mock child pid=${p.pid} exit=${exit}`);
  return { exit, out, err };
}

test('reschedule sends exact body/key/headers once and preserves booking identity', async () => {
  let calls = 0;
  const c = client(async (url, init) => {
    calls++; assert.equal(url, 'http://127.0.0.1/v1/workspaces/ws%2Fone/bookings/booking%2Fone/reschedule');
    assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body as string), intent());
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${credential}`); assert.equal(headers.get('Idempotency-Key'), moveKey);
    assert.equal(headers.get('Content-Type'), 'application/json'); assert.equal(headers.get('Accept'), 'application/json');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    return json(booking());
  });
  assert.deepEqual(await c.rescheduleBooking('booking/one', intent(), moveKey), booking()); assert.equal(calls, 1);
});

test('reschedule rejects missing/extra fields, impossible/nonUTC timestamps and invalid IDs/keys before send', async () => {
  let calls = 0; const c = client(async () => { calls++; return json(booking()); });
  for (const bad of [null, [], {}, { start: intent().start }, { ...intent(), extra: credential }, { ...intent(), offeringId: 'other' }]) assert.throws(() => c.rescheduleBooking('booking/one', bad as any, moveKey), AvailKitError);
  for (const bad of ['2026-02-30T10:00:00Z', '2026-10-20T24:00:00Z', '2026-10-20T10:00:00+00:00', '2026-10-20', '2026-10-20T10:00:00', 'nonsense', null, 5]) {
    for (const field of ['expectedStart', 'start']) assert.throws(() => c.rescheduleBooking('booking/one', { ...intent(), [field]: bad }, moveKey), AvailKitError);
  }
  for (const id of ['', ' ', '.', '..', null, 5]) assert.throws(() => c.rescheduleBooking(id as any, intent(), moveKey), AvailKitError);
  for (const k of ['', 'short', 'a'.repeat(129), ' '.repeat(16), 'a'.repeat(15) + '\n', 'é'.repeat(16), null]) assert.throws(() => c.rescheduleBooking('booking/one', intent(), k as any), AvailKitError);
  assert.equal(calls, 0);
});

test('reschedule allows same-start no-op and UTC fractions with caller-chosen boundary keys', async () => {
  for (const length of [16, 128]) {
    const body = { expectedStart: '2026-10-20T10:00:00.000Z', start: '2026-10-20T10:00:00.000000Z' };
    await client(async (_, init) => { assert.equal(new Headers(init.headers).get('Idempotency-Key'), 'x'.repeat(length)); assert.deepEqual(JSON.parse(init.body as string), body); return json(booking()); }).rescheduleBooking('booking/one', body, 'x'.repeat(length));
  }
});

test('reschedule snapshots input before caller mutation and retains exact original explicit retry intent', async () => {
  const body = intent(), saved = structuredClone(body), sent: string[] = [];
  const c = client(async (_, init) => { sent.push(init.body as string); if (sent.length === 1) throw new Error(credential); return json(booking()); });
  const first = c.rescheduleBooking('booking/one', body, moveKey); body.start = '2026-10-20T11:00:00Z';
  await assert.rejects(first, e => e instanceof AvailKitError && e.kind === 'transport' && e.cause === undefined && !String(e).includes(credential));
  assert.equal(sent.length, 1); assert.deepEqual(JSON.parse(sent[0]), saved);
  assert.deepEqual(await c.rescheduleBooking('booking/one', saved, moveKey), booking());
  assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]);
});

test('reschedule requires stable ID/confirmed Booking, bounded valid shape and correct HTTP status', async () => {
  for (const data of [{ ...booking(), id: 'other' }, { ...booking(), status: 'cancelled' }, { ...booking(), status: 'pending' }, { ...booking(), start: 'bad' }, { ...booking(), start: '2026-02-30T10:00:00Z' }, { ...booking(), end: '2027-02-30T10:00:00Z' }, { ...booking(), end: booking().start }, { ...booking(), signingSecret: credential }, { ...booking(), offeringId: null }, {}]) await assert.rejects(client(async () => json(data)).rescheduleBooking('booking/one', intent(), moveKey), protocol);
  await assert.rejects(client(async () => json(booking(), 201)).rescheduleBooking('booking/one', intent(), moveKey), protocol);
  const replay = { ...booking(), start: '2026-10-20T11:00:00Z', end: '2026-10-20T11:30:00Z' };
  // Original replay body is authoritative; the client must not reconstruct it from current state.
  assert.deepEqual(await client(async () => json(replay)).rescheduleBooking('booking/one', intent(), moveKey), replay);
});

test('reschedule preserves 400/401/403/404/409/503 safe codes and redacts reflected diagnostics', async () => {
  for (const [status, code] of [[400, 'invalid_input'], [401, 'unauthorized'], [403, 'scope_denied'], [404, 'not_found'], [409, 'capacity_conflict'], [409, 'version_conflict'], [409, 'idempotency_conflict'], [409, 'quota_exceeded'], [503, 'unavailable']] as const) {
    for (const reflected of [false, true]) {
      let calls = 0;
      await assert.rejects(client(async () => { calls++; return json({ error: { code: reflected ? credential : code, message: credential, cause: credential } }, status); }).rescheduleBooking('booking/one', intent(), moveKey), e => {
        assert(e instanceof AvailKitError); assert.equal(e.kind, 'api'); assert.equal(e.status, status); assert.equal(e.code, reflected ? 'api_error' : code);
        assert.equal(e.cause, undefined); assert(!JSON.stringify(e).includes(credential)); assert(!String(e).includes(credential)); return true;
      });
      assert.equal(calls, 1);
    }
  }
  // A management object named reschedule is still an ordinary GET.
  await assert.rejects(client(async () => json({ error: { code: 'ordinary_get_code', message: 'safe' } }, 404)).getBooking('reschedule'), e => e instanceof AvailKitError && e.code === 'api_error');
});

test('reschedule refuses malformed JSON/error/content-type/redirect and oversize response', async () => {
  const redirect = json(booking()); Object.defineProperty(redirect, 'redirected', { value: true });
  for (const r of [redirect, json(booking(), 200, { 'Content-Type': 'text/plain' }), new Response('{', { headers: { 'Content-Type': 'application/json' } }), json({ error: { code: 'bad' } }, 409)]) await assert.rejects(client(async () => r).rescheduleBooking('booking/one', intent(), moveKey), protocol);
  await assert.rejects(client(async () => json(booking()), { maxResponseBytes: 20 }).rescheduleBooking('booking/one', intent(), moveKey), e => e instanceof AvailKitError && e.code === 'response_too_large');
});

test('reschedule fetch/body deadlines abort and cancel without retries or compensation', async () => {
  for (const bodyWait of [false, true]) {
    let calls = 0, cancelled = false; let signal: AbortSignal;
    const c = client(async (_, init) => {
      calls++; signal = init.signal as AbortSignal;
      if (!bodyWait) return new Promise<Response>(resolve => signal.addEventListener('abort', () => resolve(json(booking())), { once: true }));
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } });
    }, { timeoutMs: 10 });
    await assert.rejects(c.rescheduleBooking('booking/one', intent(), moveKey), e => e instanceof AvailKitError && e.code === 'timeout');
    await new Promise(resolve => setImmediate(resolve)); assert(signal!.aborted); assert.equal(calls, 1); if (bodyWait) assert(cancelled);
  }
});

test('events accept exactly created/cancelled/rescheduled types and reject unknown kinds', async () => {
  for (const kind of ['booking.created', 'booking.cancelled', 'booking.rescheduled', 'booking.moved', '', credential]) {
    const page = { events: [{ id: 'event', sequence: 1, type: kind, bookingId: 'booking/one', occurredAt: intent().start }], nextAfter: 1, retentionFloor: 0, highWater: 1 };
    if (['booking.created', 'booking.cancelled', 'booking.rescheduled'].includes(kind)) assert.deepEqual(await client(async () => json(page)).events(), page);
    else await assert.rejects(client(async () => json(page)).events(), protocol);
  }
});

test('CLI reschedule exact args/env/file/wire and scrubbed output', async () => {
  const dir = await temp(), file = join(dir, 'move.json'), previous = globalThis.fetch;
  try {
    await writeFile(file, JSON.stringify(intent()), { mode: 0o600 });
    let calls = 0, output = '';
    globalThis.fetch = async (_, init) => { calls++; assert.deepEqual(JSON.parse(init!.body as string), intent()); assert.equal(new Headers(init!.headers).get('Idempotency-Key'), moveKey); return json({ ...booking(), resourceId: credential }); };
    await runCli(['reschedule', 'booking/one', file, moveKey], env, s => { output += s; });
    assert.equal(JSON.parse(output).resourceId, '[redacted]'); assert(!output.includes(credential));
    for (const args of [['reschedule'], ['reschedule', 'booking/one', file], ['reschedule', 'booking/one', file, moveKey, credential]]) await assert.rejects(runCli(args, env, () => {}), AvailKitError);
    for (const name of Object.keys(env)) { const missing = { ...env }; delete missing[name]; await assert.rejects(runCli(['reschedule', 'booking/one', file, moveKey], missing, () => {}), AvailKitError); }
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; await rm(dir, { recursive: true }); }
});

test('CLI reschedule bounded regular UTF8 JSON file reader rejects unsafe inputs before send', async () => {
  const dir = await temp(), file = join(dir, 'bad.json'), previous = globalThis.fetch;
  try {
    let calls = 0; globalThis.fetch = async () => { calls++; return json(booking()); };
    for (const bytes of ['{', 'x'.repeat(65537), Buffer.from([0xff]), JSON.stringify({ ...intent(), extra: 1 })]) {
      await writeFile(file, bytes, { mode: 0o600 }); await assert.rejects(runCli(['reschedule', 'booking/one', file, moveKey], env, () => {}));
    }
    for (const path of [dir, join(dir, 'missing')]) await assert.rejects(runCli(['reschedule', 'booking/one', path, moveKey], env, () => {}));
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previous; await rm(dir, { recursive: true }); }
});

test('CLI entrypoint joins eight mocked children; safe success/error/lost-response output', async () => {
  const dir = await temp(), file = join(dir, 'move.json'), cli = new URL('../src/cli.mts', import.meta.url);
  try {
    await writeFile(file, JSON.stringify(intent()), { mode: 0o600 });
    for (const status of [200, 401, 403, 404, 409, 503, 0, -1]) {
      const value = status === 200 ? booking() : status === -1 ? { ...booking(), extra: credential } : { error: { code: credential, message: credential } };
      const fetch = status === 0 ? `throw new Error(${JSON.stringify(credential)});` : `return new Response(${JSON.stringify(JSON.stringify(value))},{status:${status === -1 ? 200 : status},headers:{'Content-Type':'application/json'}});`;
      const script = `let calls=0; globalThis.fetch=async()=>{if(++calls>1)throw new Error('duplicate send'); ${fetch}}; process.argv=[process.execPath,${JSON.stringify(cli.pathname)},'reschedule','booking/one',${JSON.stringify(file)},${JSON.stringify(moveKey)}]; await import(${JSON.stringify(cli.href)}); process.on('beforeExit',()=>{if(calls!==1)process.exitCode=99;});`;
      const result = await child(script, []);
      assert.equal(result.exit, status === 200 ? 0 : 1);
      if (status === 200) assert.deepEqual(JSON.parse(result.out), booking());
      else { assert.equal(result.out, ''); assert.match(result.err, /original reschedule input, booking ID and key/); assert.match(result.err, /No automatic retry, cancel or rebook was sent/); assert(!result.err.includes(file)); }
    }
  } finally { await rm(dir, { recursive: true }); }
});

function journeyFetch(loseMove = false): Fetch {
  let sequence = 0;
  return async (url, init) => {
    const step = sequence++;
    if (step === 0) { assert(url.endsWith('/bookings')); assert.equal(init.method, 'POST'); return json({ ...booking(), start: intent().expectedStart, end: '2026-10-20T09:30:00Z' }, 201); }
    if (step <= 2) { assert(url.endsWith('/reschedule')); assert.deepEqual(JSON.parse(init.body as string), intent()); assert.equal(new Headers(init.headers).get('Idempotency-Key'), moveKey); if (loseMove) throw new Error(credential); return json(booking()); }
    if (step === 3) { assert(url.endsWith('/cancel')); return json({ ...booking(), status: 'cancelled' }); }
    assert.equal(init.method, 'GET'); assert(url.includes('/events?'));
    const events = step === 4 ? ['booking.created', 'booking.rescheduled', 'booking.cancelled'].map((type, i) => ({ id: `event${i}`, sequence: i + 1, type, bookingId: booking().id, occurredAt: intent().start })) : [];
    return json({ events, nextAfter: 3, retentionFloor: 0, highWater: 3 });
  };
}

test('helper saves plan/booking before move, replays same intent, cancels and observes three event kinds', async () => {
  const checkpoints: any[] = [];
  const result = await runReschedule(client(journeyFetch()), plan(), async state => { checkpoints.push(structuredClone(state)); });
  assert.deepEqual(result, { bookingId: booking().id, status: 'cancelled', eventCount: 3 });
  assert.deepEqual(checkpoints.map(x => x.phase), ['before_book', 'before_move', 'before_replay', 'before_cancel', 'before_events', 'complete']);
  assert.deepEqual(checkpoints[0].plan, plan()); assert.equal(checkpoints[1].booked.id, booking().id);
});

test('helper stops at uncertain move or failed persistence without compensation and retains original input/key', async () => {
  const checkpoints: any[] = []; let calls = 0;
  const fetch = journeyFetch(true);
  await assert.rejects(runReschedule(client(async (url, init) => { calls++; return fetch(url, init); }), plan(), async state => { checkpoints.push(structuredClone(state)); }), AvailKitError);
  assert.equal(calls, 2); assert.equal(checkpoints.at(-1).phase, 'before_move'); assert.deepEqual(checkpoints.at(-1).plan.move, intent()); assert.equal(checkpoints.at(-1).plan.keys.move, moveKey);
  calls = 0;
  await assert.rejects(runReschedule(client(async () => { calls++; return json(booking()); }), plan(), async () => { throw new Error('private checkpoint failed'); }));
  assert.equal(calls, 0);
});

test('helper rejects invalid plan or same-slot move before sending', async () => {
  let calls = 0; const c = client(async () => { calls++; return json(booking()); });
  for (const bad of [{ ...plan(), extra: 1 }, { ...plan(), move: { ...intent(), start: intent().expectedStart } }, { ...plan(), keys: { ...plan().keys, move: 'short' } }, { ...plan(), move: { ...intent(), expectedStart: '2026-10-20T08:00:00Z' } }]) await assert.rejects(runReschedule(c, bad, async () => {}));
  assert.equal(calls, 0);
});

test('example executable joins three mock children and persists private checkpoint receipts across loss', async () => {
  const dir = await temp(), file = join(dir, 'plan.json'), executable = new URL('../scenarios/m7/run.mts', import.meta.url);
  try {
    await writeFile(file, JSON.stringify(plan()), { mode: 0o600 });
    // Serialize the mock definition only; no real listener or fetch is used.
    const definitions = `const credential=${JSON.stringify(credential)}; const intent=${intent.toString()}; const booking=${booking.toString()}; const moveKey=${JSON.stringify(moveKey)}; const json=${json.toString()}; const assert=(await import('node:assert/strict')).default; const journeyFetch=${journeyFetch.toString()};`;
    for (const lost of [false, true]) {
      const receipt = join(dir, lost ? 'lost.jsonl' : 'ok.jsonl');
      const script = `${definitions} globalThis.fetch=journeyFetch(${lost}); process.argv=[process.execPath,${JSON.stringify(executable.pathname)},${JSON.stringify(file)},${JSON.stringify(receipt)}]; await import(${JSON.stringify(executable.href)});`;
      const result = await child(script, []); assert.equal(result.exit, lost ? 1 : 0);
      const receipts = (await readFile(receipt, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
      assert.equal((await stat(receipt)).mode & 0o777, 0o600); assert.deepEqual(receipts[0].plan, plan());
      assert.equal(receipts.at(-1).phase, lost ? 'before_move' : 'complete');
      if (lost) { assert.equal(receipts.at(-1).booked.id, booking().id); assert.equal(result.out, ''); assert.match(result.err, /original booking ID, input and key/); }
      else assert.deepEqual(JSON.parse(result.out), { status: 'cancelled', eventCount: 3 });
    }
    const existing = join(dir, 'ok.jsonl'), saved = await readFile(existing);
    const script = `globalThis.fetch=async()=>{process.exitCode=99;throw new Error('unexpected send');};process.argv=[process.execPath,${JSON.stringify(executable.pathname)},${JSON.stringify(file)},${JSON.stringify(existing)}];await import(${JSON.stringify(executable.href)});`;
    assert.equal((await child(script, [])).exit, 1); assert.deepEqual(await readFile(existing), saved);
  } finally { await rm(dir, { recursive: true }); }
});

test('CLI help documents explicit reschedule with same input and key', () => {
  assert.match(help, /reschedule BOOKING_ID INPUT.json IDEMPOTENCY_KEY/); assert.match(help, /Only deliberately replay the exact/);
  assert.match(help, /current authority within24hours/);
  assert.match(help, /Expired keys[\s\S]*may begin a new mutation/);
});
