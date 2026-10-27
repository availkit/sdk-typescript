import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, writeFile, symlink, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { exportWorkspace, ExportError, exportFailure, parseExportArgs } from '../src/export.mts';
import type { ExportDependencies } from '../src/export.mts';
import type { Fetch } from '../src/index.ts';
import { runCli, help } from '../src/cli.mts';

// Declared inventory: serial injected-fetch traversal; every projected field and
// closed boundary; reflected credentials/errors; authority; ID/cursor/event loops;
// call/work/record/byte bounds; private path reservation; short writes and disk
// failures; delayed cancellation joins; foreground CLI children and parsing.
// No listeners, real fetch, dependency install, business server or database.
const credential = 'synthetic-export-private-credential';
const config = { baseUrl: 'http://127.0.0.1', workspaceId: 'workspace-one', credential };
const env = { AVAILKIT_BASE_URL: config.baseUrl, AVAILKIT_WORKSPACE_ID: config.workspaceId, AVAILKIT_CREDENTIAL: credential };
const options = { output: 'unused-private-output', maxCalls: 2048, workSeconds: 30 };
const when = '2026-10-19T00:00:00Z';
const hex = (n: number) => n.toString(16).padStart(32, '0');
const counterKeys = ['monthlyBookingCreates', 'catalogObjects', 'bookingRecords', 'committedEvents', 'webhookSubscriptions', 'webhookDeliveries', 'liveReplays', 'customerRecords'];
function fixture() {
  return {
    usage: { asOf: when, period: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' }, counters: Object.fromEntries(counterKeys.map(k => [k, { used: 1, limit: 10, remaining: 9 }])) },
    resources: [{ id: 'resource-1', name: 'Private room', timeZone: 'UTC', capacity: 2, archived: false }],
    hours: { windows: [{ weekday: 1, start: '09:00', end: '24:00' }] },
    offerings: [{ id: 'offering-1', name: 'Consultation', resourceId: 'resource-1', durationMinutes: 30, archived: false }],
    bookings: [{ id: 'booking-1', offeringId: 'offering-1', resourceId: 'resource-1', start: when, end: '2026-10-19T00:30:00Z', status: 'cancelled' }],
    events: [{ id: hex(3), sequence: 1, type: 'booking.rescheduled', bookingId: 'booking-1', occurredAt: when }],
    webhooks: [{ id: hex(1), url: 'https://private.invalid/token-never-export', enabled: false, createdAt: when }],
    deliveries: [{ id: hex(2), subscriptionId: hex(1), eventId: hex(3), state: 'dead', createdAt: when, attempts: 5, maxAttempts: 5, nextAttemptAt: null, leaseExpiresAt: null, lastAttemptAt: when, lastOutcome: 'disabled_unknown', lastHttpStatus: 503 }],
  };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
function mock(data = fixture(), change?: (path: string, value: any, query: URLSearchParams) => any) {
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${credential}`);
    assert.equal(new Headers(init.headers).has('Idempotency-Key'), false);
    const u = new URL(url), path = u.pathname.replace('/v1/workspaces/workspace-one', ''); calls.push(u.pathname + u.search);
    let value: any;
    if (path === '/usage') value = structuredClone(data.usage);
    else if (path.endsWith('/hours')) value = structuredClone(data.hours);
    else if (path === '/events') {
      const events = data.events.filter(e => e.sequence > Number(u.searchParams.get('after') ?? 0)).slice(0, 100);
      value = { events, nextAfter: events.at(-1)?.sequence ?? Number(u.searchParams.get('after') ?? 0), retentionFloor: 0, highWater: data.events.at(-1)?.sequence ?? 0 };
    } else {
      const key = path.endsWith('/deliveries') ? 'deliveries' : path.slice(1) as keyof typeof data;
      const items = (data[key] as any[]).filter(x => x.id > (u.searchParams.get('after') ?? '')).slice(0, 100);
      value = { items: structuredClone(items), nextAfter: items.length === 100 ? items.at(-1).id : null };
    }
    return json(change ? change(path, value, u.searchParams) : value);
  };
  return { fetch, calls };
}
function memoryFile(partial = Infinity) {
  const chunks: Buffer[] = []; let closed = 0, synced = 0, mode = 0;
  return {
    file: { async stat() { return { isFile: () => true }; }, async chmod(n: number) { mode = n; },
      async write(buffer: Buffer, offset: number, length: number) { const n = Math.min(length, partial); chunks.push(Buffer.from(buffer.subarray(offset, offset + n))); return { bytesWritten: n }; },
      async sync() { synced++; }, async close() { closed++; } } as any,
    get text() { return Buffer.concat(chunks).toString(); },
    get closed() { return closed; }, get synced() { return synced; }, get mode() { return mode; },
  };
}
function run(fetch: Fetch, deps: ExportDependencies = {}, opts = options) {
  const memory = memoryFile();
  return { memory, result: exportWorkspace(opts, config, { reserve: async () => memory.file, fetch, ...deps }) };
}
const safeError = (error: unknown) => error instanceof ExportError && error.cause === undefined && !String(error).includes(credential) && Object.keys(error).every(k => k === 'name');
const privateRoot = () => mkdtemp(join(process.env.M8_TEST_ROOT ?? tmpdir(), 'export-'));

test('closed projected records, authority-first order, exact end/summary counters and short writes', async () => {
  const source = fixture(), m = mock(source), memory = memoryFile(7);
  const summary = await exportWorkspace(options, config, { fetch: m.fetch, reserve: async () => memory.file });
  const lines = memory.text.trimEnd().split('\n'), records = lines.map(x => JSON.parse(x));
  assert.deepEqual(records.map(x => x.type), ['header', 'usage', 'webhook', 'delivery', 'resource', 'hours', 'offering', 'booking', 'event-retention', 'event', 'end']);
  assert.deepEqual(records[0].data, { schemaVersion: 2, configuredWorkspaceId: config.workspaceId, scope: 'credential-selected', consistency: 'per-response' });
  const expected = [source.usage, { id: hex(1), enabled: false, createdAt: when }, source.deliveries[0], source.resources[0], { resourceId: 'resource-1', windows: source.hours.windows }, source.offerings[0], source.bookings[0], source.events[0]];
  const dataRecords=records.filter(x=>!['header','event-retention','end'].includes(x.type));
  expected.forEach((value, i) => assert.deepEqual(dataRecords[i], { type: dataRecords[i].type, data: value }));
  assert.deepEqual(records.find(x=>x.type==='event-retention').data,{retentionFloor:0,highWater:1});
  const beforeEnd = Buffer.byteLength(lines.slice(0, -1).join('\n') + '\n');
  assert.deepEqual(records.at(-1), { type: 'end', data: { traversalComplete: true, recordCount: 8, requestCount: 8, bytesBeforeEnd: beforeEnd, counts: { usage: 1, resource: 1, hours: 1, offering: 1, booking: 1, event: 1, webhook: 1, delivery: 1 } } });
  assert.deepEqual(summary, { status: 'complete', records: 8, requests: 8, bytes: Buffer.byteLength(memory.text) });
  assert.equal(memory.closed, 1); assert.equal(memory.synced, 1); assert.equal(memory.mode, 0o600);
  assert(m.calls[0].endsWith('/webhooks?limit=100')); assert(m.calls[1].endsWith('/usage'));
  assert(!memory.text.includes('private.invalid')); assert(!memory.text.includes(credential));
});

test('stable multipage collections and events, then empty terminal pages; serialized requests', async () => {
  const source = fixture();
  source.resources = Array.from({ length: 101 }, (_, i) => ({ ...source.resources[0], id: `r${String(i).padStart(3, '0')}` }));
  source.offerings = Array.from({ length: 101 }, (_, i) => ({ ...source.offerings[0], id: `o${String(i).padStart(3, '0')}` }));
  source.bookings = Array.from({ length: 100 }, (_, i) => ({ ...source.bookings[0], id: `b${String(i).padStart(3, '0')}` }));
  source.events = Array.from({ length: 100 }, (_, i) => ({ ...source.events[0], id: hex(i + 1), sequence: i + 1 }));
  source.webhooks = Array.from({ length: 101 }, (_, i) => ({ ...source.webhooks[0], id: hex(i + 1) }));
  source.deliveries = [];
  const m = mock(source); let active = 0, maximum = 0;
  const r = run(async (url, init) => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); try { return await m.fetch(url, init); } finally { active--; } });
  const summary = await r.result;
  assert.equal(summary.records, 605); assert.equal(summary.requests, 213); assert.equal(maximum, 1); assert.equal(active, 0);
  const end = JSON.parse(r.memory.text.trim().split('\n').at(-1)!);
  assert.equal(end.data.counts.hours, 101); assert.equal(end.data.counts.event, 100);
  assert(m.calls.some(x => x.includes('/events?after=100&limit=100')));
  assert(m.calls.some(x => x.includes('/bookings?after=b099&limit=100')));
});

test('empty collections emit only header/usage/end and honest invocation count', async () => {
  const source = fixture(); for (const key of ['resources', 'offerings', 'bookings', 'events', 'webhooks', 'deliveries'] as const) source[key] = [];
  const m = mock(source), r = run(m.fetch); assert.equal((await r.result).requests, 6);
  assert.deepEqual(r.memory.text.trim().split('\n').map(x => JSON.parse(x).type), ['header', 'usage', 'event-retention', 'end']);
});

test('delivery multipage traversal includes every allowed state/outcome and nullable timestamp form', async () => {
  const source = fixture();
  const states = ['pending', 'suppressed', 'leased', 'sending', 'delivered', 'dead'];
  const outcomes = [null, 'admitted_unknown', 'claim_expired', 'lease_expired_unknown', 'disabled_unknown', 'not_attempted', 'invalid_target', 'invalid_delivery', 'address_denied', 'transport_unknown', 'deadline_unknown', 'http_drained', 'http_body_failed', 'http_body_deadline', 'http_body_too_large'];
  source.deliveries = Array.from({ length: 101 }, (_, i) => ({ ...source.deliveries[0], id: hex(i + 1), state: states[i % states.length], attempts: i % 6,
    nextAttemptAt: i % 2 ? when : null, leaseExpiresAt: i % 2 ? when : null, lastAttemptAt: i % 2 ? null : when, lastOutcome: outcomes[i % outcomes.length], lastHttpStatus: i % 2 ? null : 200 }));
  const m = mock(source), r = run(m.fetch); await r.result;
  const lines = r.memory.text.trim().split('\n').map(x => JSON.parse(x)).filter(x => x.type === 'delivery');
  assert.deepEqual(lines.map(x => x.data), source.deliveries);
  assert.equal(m.calls.filter(x => x.includes('/deliveries?')).length, 2);
});

test('every response field rejects missing/invalid type; every boundary rejects unknown/private fields', async () => {
  const source = fixture();
  const targets: [string, string[], (v: any) => any][] = [
    ['/usage', ['asOf', 'period', 'counters'], v => v], ['/usage', ['start', 'end'], v => v.period],
    ['/usage', counterKeys, v => v.counters], ...counterKeys.map(k => ['/usage', ['used', 'limit', 'remaining'], (v: any) => v.counters[k]] as [string, string[], (v: any) => any]),
    ...(['resources', 'offerings', 'bookings', 'webhooks'] as const).map(k => [`/${k}`, Object.keys(source[k][0]), (v: any) => v.items[0]] as [string, string[], (v: any) => any]),
    [`/webhooks/${hex(1)}/deliveries`, Object.keys(source.deliveries[0]), v => v.items[0]],
    ['/resources/resource-1/hours', ['windows'], v => v], ['/resources/resource-1/hours', ['weekday', 'start', 'end'], v => v.windows[0]],
    ['/events', Object.keys(source.events[0]), v => v.events[0]],
    ...['/resources', '/offerings', '/bookings', '/webhooks', `/webhooks/${hex(1)}/deliveries`].map(p => [p, ['items', 'nextAfter'], (v: any) => v] as [string, string[], (v: any) => any]),
    ['/events', ['events', 'nextAfter'], v => v],
  ];
  let checked = 0;
  for (const [path, fields, locate] of targets) {
    for (const field of fields) for (const variant of ['missing', 'type']) {
      const m = mock(fixture(), (p, v) => {
        if (p === path) { const target = locate(v); if (variant === 'missing') delete target[field]; else target[field] = {}; }
        return v;
      });
      const r = run(m.fetch); await assert.rejects(r.result, safeError); assert.equal(r.memory.closed, 1); checked++;
    }
    const m = mock(fixture(), (p, v) => { if (p === path) locate(v).privatePayload = credential; return v; });
    const r = run(m.fetch); await assert.rejects(r.result, safeError); assert(!r.memory.text.includes(credential)); checked++;
  }
  assert(checked > 180);
});

test('semantic calendar, numeric, enums, hours, IDs and nested-private rejection', async () => {
  const variants: [string, (v: any) => void][] = [
    ['/resources', v => v.items[0].capacity = 0], ['/resources', v => v.items[0].capacity = 1.5],
    ['/resources', v => v.items[0].id = 'x'.repeat(257)], ['/resources', v => v.items[0].id = 'é'.repeat(129)],
    ['/resources', v => v.items[0].id = '..'], ['/resources', v => v.items[0].name = ''],
    ['/offerings', v => v.items[0].durationMinutes = -1], ['/offerings', v => v.items[0].resourceId = 'x'.repeat(257)],
    ['/bookings', v => v.items[0].status = 'private'], ['/bookings', v => v.items[0].start = '2026-02-30T00:00:00Z'],
    ['/bookings', v => v.items[0].end = v.items[0].start], ['/events', v => v.events[0].sequence = 0],
    ['/events', v => v.events[0].type = 'private'], ['/events', v => v.events[0].occurredAt = '2026-02-30T00:00:00Z'],
    ['/resources/resource-1/hours', v => v.windows[0].weekday = 8], ['/resources/resource-1/hours', v => v.windows[0].start = '24:00'],
    ['/resources/resource-1/hours', v => v.windows[0].end = '09:00'], ['/resources/resource-1/hours', v => v.windows = Array(29).fill(v.windows[0])],
    ['/usage', v => v.counters.catalogObjects.remaining = 10], ['/webhooks', v => v.items[0].createdAt = '2026-02-30T00:00:00Z'],
  ];
  for (const [path, mutate] of variants) {
    const r = run(mock(fixture(), (p, v) => { if (p === path) mutate(v); return v; }).fetch);
    await assert.rejects(r.result, safeError);
  }
});

test('actual literal and escaped configured credential rejected in each projected string family', async () => {
  for (const [key, field] of [['resources', 'name'], ['resources', 'id'], ['resources', 'timeZone'], ['offerings', 'name'], ['offerings', 'resourceId'], ['bookings', 'offeringId'], ['bookings', 'resourceId'], ['events', 'bookingId']] as const) {
    const source = fixture(); (source[key][0] as any)[field] = credential;
    const r = run(mock(source).fetch); await assert.rejects(r.result, safeError); assert(!r.memory.text.includes(credential));
  }
  const special = 'secret-"-\\-value'; const source = fixture(); source.resources[0].name = `prefix${special}suffix`;
  const m = mock(source); const memory = memoryFile();
  await assert.rejects(exportWorkspace(options, { ...config, credential: special }, { reserve: async () => memory.file, fetch: async (url, init) => m.fetch(url, { ...init, headers: { Authorization: `Bearer ${credential}` } }) }), safeError);
  assert(!memory.text.includes(JSON.stringify(special).slice(1, -1)));
});

test('MANAGE/READ refusal and arbitrary reflected API/transport errors stay safe and never retry', async () => {
  for (const status of [401, 403]) for (const at of [1, 2]) {
    const m = mock(); let calls = 0; const r = run(async (url, init) => ++calls === at ? json({ error: { code: credential, message: credential, cause: credential } }, status) : m.fetch(url, init));
    await assert.rejects(r.result, safeError); assert.equal(calls, at); assert.equal(r.memory.text, ''); assert.equal(r.memory.closed, 1);
  }
  for (const at of [1, 3, 5]) for (const transport of [false, true]) {
    const m = mock(); let calls = 0; const r = run(async (url, init) => { if (++calls === at) { if (transport) throw new Error(credential); return json({ error: { code: credential, message: credential } }, 503); } return m.fetch(url, init); });
    await assert.rejects(r.result, safeError); assert.equal(calls, at); assert(!r.memory.text.includes(credential)); assert(!r.memory.text.includes('"type":"end"'));
  }
});

test('reject duplicate/nonadvancing IDs/cursors and event IDs/sequences without loops', async () => {
  for (const path of ['/resources', '/offerings', '/bookings', '/webhooks', `/webhooks/${hex(1)}/deliveries`]) {
    for (const kind of ['duplicate', 'cursor', 'oversize', 'long-cursor']) {
      const m = mock(fixture(), (p, v) => {
        if (p !== path) return v;
        if (kind === 'duplicate') v.items.push(v.items[0]);
        else if (kind === 'cursor') v.nextAfter = 'stuck';
        else if (kind === 'long-cursor') v.nextAfter = 'x'.repeat(4097);
        else v.items = Array(101).fill(v.items[0]);
        return v;
      });
      const r = run(m.fetch); await assert.rejects(r.result, safeError); assert(m.calls.length < 10);
    }
  }
  for (const kind of ['duplicate-id', 'sequence', 'next', 'empty-next']) {
    const m = mock(fixture(), (p, v) => {
      if (p === '/events') {
        if (kind === 'duplicate-id') v.events.push({ ...v.events[0], sequence: 2 });
        if (kind === 'sequence') v.events.push({ ...v.events[0], id: hex(4) });
        if (kind === 'next') v.nextAfter = 0;
        if (kind === 'empty-next') { v.events = []; v.nextAfter = 1; }
      } return v;
    }); await assert.rejects(run(m.fetch).result, safeError);
  }
  // Cross-page repeated/nonadvancing cursor is refused on the second page.
  const source = fixture(); source.resources = Array.from({ length: 100 }, (_, i) => ({ ...source.resources[0], id: `r${String(i).padStart(3, '0')}` }));
  const m = mock(source, (p, v, q) => p === '/resources' && q.has('after') ? { items: source.resources, nextAfter: 'r099' } : v);
  await assert.rejects(run(m.fetch).result, safeError); assert.equal(m.calls.filter(x => x.includes('/resources?')).length, 2);
});

test('call, monotonic work admission, record and encoded UTF8 byte budgets stop incomplete', async () => {
  for (const n of [1, 2, 4, 7]) {
    const m = mock(), r = run(m.fetch, {}, { ...options, maxCalls: n });
    await assert.rejects(r.result, safeError); assert.equal(m.calls.length, n); assert(!r.memory.text.includes('"type":"end"'));
  }
  let tick = 0; const m = mock(); const r = run(m.fetch, { now: () => tick++ === 0 ? 0 : 30_001 });
  await assert.rejects(r.result, safeError); assert.equal(m.calls.length, 0); assert.equal(r.memory.text, '');
  const source = fixture(); source.resources[0].name = 'é'.repeat(1000);
  const baseline = run(mock(source).fetch); const complete = await baseline.result;
  const exact = run(mock(source).fetch, { limits: { records: 11, bytes: complete.bytes } }); assert.equal((await exact.result).bytes, complete.bytes);
  for (const limits of [{ records: 10 }, { bytes: complete.bytes - 1 }, { bytes: 10 }]) {
    const r = run(mock(source).fetch, { limits }); await assert.rejects(r.result, safeError); assert.equal(r.memory.synced, 0);
  }
  for (const limits of [{ records: 50_001 }, { bytes: 33 * 1024 * 1024 }]) {
    const m = mock(); await assert.rejects(run(m.fetch, { limits }).result, safeError); assert.equal(m.calls.length, 0);
  }
});

test('exclusive0600 regular reservation precedes HTTP; existing/symlink/directory refusal sends zero reads', async () => {
  const root = await privateRoot(), existing = join(root, 'existing'), link = join(root, 'link'), dir = join(root, 'directory');
  await writeFile(existing, 'preserve', { mode: 0o600 }); await symlink(existing, link); await mkdir(dir, { mode: 0o700 });
  const rootMode = (await stat(root)).mode & 0o777;
  for (const output of [existing, link, dir]) {
    const m = mock(); await assert.rejects(exportWorkspace({ ...options, output }, config, { fetch: m.fetch }), safeError); assert.equal(m.calls.length, 0);
  }
  assert.equal(await readFile(existing, 'utf8'), 'preserve');
  const output = join(root, 'new.jsonl'), m = mock();
  const summary = await exportWorkspace({ ...options, output }, config, { fetch: async (url, init) => {
    const s = await stat(output); assert(s.isFile()); assert.equal(s.mode & 0o777, 0o600);
    if (m.calls.length < 2) assert.equal(s.size, 0); return m.fetch(url, init);
  } });
  assert.equal((await stat(root)).mode & 0o777, rootMode); assert.equal((await stat(output)).size, summary.bytes);
});

test('write zero/throw, stat/chmod/sync/close errors retain private incomplete or ambiguous artifact', async () => {
  const root = await privateRoot();
  for (const mode of ['stat', 'chmod', 'zero', 'partial-throw', 'sync', 'close']) {
    const output = join(root, mode); let writes = 0, closes = 0;
    const m = mock(); let handle: Awaited<ReturnType<typeof open>>;
    await assert.rejects(exportWorkspace({ ...options, output }, config, { fetch: m.fetch, reserve: async path => {
      handle = await open(path, 'wx', 0o600);
      return { stat: async () => { if (mode === 'stat') throw new Error(credential); return handle.stat(); },
        chmod: async n => { if (mode === 'chmod') throw new Error(credential); return handle.chmod(n); },
        write: async (...args: any[]) => {
          if (mode === 'zero') return { bytesWritten: 0 };
          if (mode === 'partial-throw') { if (++writes > 1) throw new Error(credential); return handle.write(args[0], args[1], 5, null); }
          return (handle.write as any)(...args);
        },
        sync: async () => { if (mode === 'sync') throw new Error(credential); await handle.sync(); },
        close: async () => { closes++; await handle.close(); if (mode === 'close') throw new Error(credential); },
      } as any;
    } }), safeError);
    assert.equal(closes, 1); const bytes = await readFile(output, 'utf8'); assert.equal((await stat(output)).mode & 0o777, 0o600);
    if (['stat', 'chmod', 'zero'].includes(mode)) assert.equal(bytes.length, 0);
    if (['stat', 'chmod'].includes(mode)) assert.equal(m.calls.length, 0);
    if (mode === 'partial-throw') assert.equal(bytes.length, 5);
    if (['sync', 'close'].includes(mode)) assert(bytes.includes('"type":"end"'));
  }
});

test('timeout joins late fetch and delayed body cancellation before closing; no next read', async () => {
  for (const phase of ['fetch', 'body', 'invalid-header']) {
    let settled = false, cancelled = false, calls = 0, tick = 0;
    const file = memoryFile(); const close = file.file.close;
    file.file.close = async () => { assert(settled); assert(cancelled); await close(); };
    const fetch: Fetch = async () => {
      calls++;
      if (phase === 'fetch') await new Promise(resolve => setTimeout(resolve, 30));
      const body = new ReadableStream<Uint8Array>({
        pull() { return new Promise<void>(resolve => setTimeout(() => { settled = true; resolve(); }, 35)); },
        async cancel() { await new Promise(resolve => setTimeout(resolve, 20)); settled = true; cancelled = true; },
      }, { highWaterMark: 0 });
      return new Response(body, { headers: { 'content-type': phase === 'invalid-header' ? 'text/plain' : 'application/json' } });
    };
    await assert.rejects(exportWorkspace(options, config, { fetch, reserve: async () => file.file, now: () => tick++ === 0 ? 0 : 29_990 }), safeError);
    assert.equal(calls, 1); assert.equal(file.closed, 1); assert(settled); assert(cancelled);
  }
});

test('local config/argument errors precede reservation; parser boundaries and help preserve other commands', async () => {
  for (const args of [[], ['--max-calls', '1'], ['x', '--max-calls'], ['x', '--max-calls', '0'], ['x', '--max-calls', '2049'], ['x', '--work-seconds', '61'], ['x', '--work-seconds', '1.5'], ['x', '--max-calls', '01'], ['x', '--max-calls', '1', '--max-calls', '2'], ['x', '--unknown', '1'], ['x', 'extra']]) assert.throws(() => parseExportArgs(args), safeError);
  assert.deepEqual(parseExportArgs(['x', '--work-seconds', '60', '--max-calls', '2048']), { output: 'x', workSeconds: 60, maxCalls: 2048 });
  assert.deepEqual(parseExportArgs(['x', '--max-calls', '1', '--work-seconds', '1']), { output: 'x', maxCalls: 1, workSeconds: 1 });
  for (const change of [{ credential: undefined }, { workspaceId: undefined }, { baseUrl: undefined }, { baseUrl: 'file:///secret' }, { credential: 'bad credential' }, { workspaceId: credential }]) {
    let reserved = 0; const m = mock(); await assert.rejects(exportWorkspace(options, { ...config, ...change } as any, { fetch: m.fetch, reserve: async () => { reserved++; return memoryFile().file; } }), safeError);
    assert.equal(reserved, 0); assert.equal(m.calls.length, 0);
  }
  let output = ''; await runCli(['--help'], {}, x => output += x); assert.equal(output, help + '\n'); assert(help.includes('export OUTPUT.jsonl'));
  for (const args of [['usage', 'extra'], ['reschedule'], ['webhook', 'unknown'], ['events', '1', '2', 'extra']]) await assert.rejects(runCli(args, env, () => assert.fail()));
});

async function child(args: string[], root: string, mode = 'complete', extraEnv = {}) {
  const loader = join(root, 'fetch.mjs');
  await writeFile(loader, `import{appendFile}from'node:fs/promises';const mode=${JSON.stringify(mode)};globalThis.fetch=async(url,init)=>{if(mode==='no-http')await appendFile(${JSON.stringify(join(root, 'unexpected-http'))},'unexpected',{mode:384});if(init.method!=='GET')throw Error('mutation');const path=new URL(url).pathname;let value;if(mode==='refused')return new Response(JSON.stringify({error:{code:'reflected-private',message:'reflected-private'}}),{status:403,headers:{'content-type':'application/json'}});if(path.endsWith('/usage'))value=${JSON.stringify(fixture().usage)};else if(path.endsWith('/events'))value={events:[],nextAfter:0,retentionFloor:0,highWater:0};else value={items:[],nextAfter:null};return new Response(JSON.stringify(value),{headers:{'content-type':'application/json','cache-control':'no-store'}})};`, { mode: 0o600 });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(process.execPath, ['--max-old-space-size=96', '--import', loader, 'src/cli.mts', ...args], { cwd: new URL('../', import.meta.url), env: { ...process.env, ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; proc.stdout.on('data', x => stdout += x); proc.stderr.on('data', x => stderr += x); proc.on('error', reject);
    proc.on('close', (code, signal) => { try { assert.equal(signal, null); resolve({ code, stdout, stderr }); } catch (e) { reject(e); } });
  });
}

test('actual CLI children close with exact private success, safe failure, no-HTTP refusal and affected parsing exits', async () => {
  const root = await privateRoot(), output = join(root, 'actual.jsonl');
  const success = await child(['export', output], root);
  assert.equal(success.code, 0); assert.equal(success.stderr, ''); const summary = JSON.parse(success.stdout);
  assert.deepEqual(Object.keys(summary), ['status', 'records', 'requests', 'bytes']); assert.equal(summary.status, 'complete'); assert.equal(summary.records, 1); assert.equal(summary.requests, 6); assert.equal(summary.bytes, (await stat(output)).size);
  for (const [args, mode, extra] of [
    [['export', output], 'no-http', {}], [['export', join(root, 'refused')], 'refused', {}],
    [['export', join(root, 'limited'), '--max-calls', '1'], 'complete', {}],
    [['export', join(root, 'invalid'), '--work-seconds', '0'], 'complete', {}],
    [['export', join(root, 'config')], 'complete', { AVAILKIT_CREDENTIAL: '' }],
  ] as const) {
    const r = await child([...args], root, mode, extra); assert.equal(r.code, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, exportFailure); assert(!r.stderr.includes(output));
  }
  const link = join(root, 'existing-link'), directory = join(root, 'existing-directory');
  await symlink(output, link); await mkdir(directory, { mode: 0o700 });
  for (const path of [link, directory]) { const r = await child(['export', path], root, 'no-http'); assert.deepEqual(r, { code: 1, stdout: '', stderr: exportFailure }); }
  await assert.rejects(stat(join(root, 'unexpected-http')), { code: 'ENOENT' });
  const hidden = await child(['export'], root, 'complete', { AVAILKIT_CREDENTIAL: 'export' }); assert.equal(hidden.code, 1); assert.equal(hidden.stderr, '');
  const cliHelp = await child(['help'], root); assert.equal(cliHelp.code, 0); assert.equal(cliHelp.stdout, help + '\n');
  const usage = await child(['usage'], root); assert.equal(usage.code, 0); assert.deepEqual(JSON.parse(usage.stdout), fixture().usage);
  for (const args of [['usage', 'extra'], ['webhook', 'unknown'], ['reschedule']]) { const r = await child(args, root); assert.equal(r.code, 1); assert.equal(r.stdout, ''); assert(r.stderr.startsWith('AvailKit input failed.')); }
});

test('customer booking export keeps only opaque association and never reads customer contacts', async () => {
  const m = mock(fixture(), (path, value) => path === '/bookings' ? { ...value, items: value.items.map((row: Record<string, unknown>) => ({ ...row, customerId: hex(99) })) } : value);
  const memory = memoryFile(); await exportWorkspace(options, config, { fetch: m.fetch, reserve: async () => memory.file });
  const booking = memory.text.trim().split('\n').map(x => JSON.parse(x)).find(x => x.type === 'booking');
  assert.equal(booking.data.customerId, hex(99)); assert(!m.calls.some(path => path.includes('/customers'))); assert(!memory.text.includes('person@example.invalid'));
});
test('customer booking export rejects malformed links and accidental contact fields', async () => {
  for (const extra of [{ customerId: null }, { customerId: 'contact@example.invalid' }, { customerId: hex(99), email: 'contact@example.invalid' }]) {
    const m = mock(fixture(), (path, value) => path === '/bookings' ? { ...value, items: value.items.map((row: Record<string, unknown>) => ({ ...row, ...extra })) } : value);
    const memory = memoryFile(); await assert.rejects(exportWorkspace(options, config, { fetch: m.fetch, reserve: async () => memory.file }), safeError);
    assert(!memory.text.includes('contact@example.invalid'));
  }
});

 test('version2 export records an empty retained event suffix without inventing full history', async()=>{
 const data=fixture();data.events=[];const m=mock(data,(path,value)=>path==='/events'?{events:[],nextAfter:5,retentionFloor:5,highWater:5}:value);const result=run(m.fetch);await result.result;
 const rows=result.memory.text.trim().split('\n').map(x=>JSON.parse(x));assert.equal(rows[0].data.schemaVersion,2);assert.deepEqual(rows.find(x=>x.type==='event-retention').data,{retentionFloor:5,highWater:5});assert.equal(rows.at(-1).type,'end');
 });
