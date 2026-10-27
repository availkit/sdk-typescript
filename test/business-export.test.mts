import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, symlink, open, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fetch } from '../src/index.ts';
import { BusinessExportClient, BusinessExportError, businessExportSections, businessExportText } from '../src/business-export.ts';
import { exportBusinessFile, parseBusinessExportArgs } from '../src/business-export-file.mts';

const id = (n: number) => n.toString(16).padStart(32, '0');
const credential = 'BusinessExportSyntheticPrivateCredential_1234';
const asOf = '2026-10-27T09:00:00.000Z';
const scope = { organizationId: id(1), workspaceId: id(2), environment: 'test' as const };
const counter = { used: 0, limit: 100, remaining: 100 };
const configuration = {
  bookingPage: { pageId: id(3), title: 'Synthetic page', enabled: false, needsRepublish: false },
  usage: { asOf, period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' }, counters: Object.fromEntries(['monthlyBookingCreates', 'catalogObjects', 'bookingRecords', 'committedEvents', 'webhookSubscriptions', 'webhookDeliveries', 'liveReplays', 'customerRecords'].map(name => [name, { ...counter }])) },
  eventRetention: { retentionFloor: 0, highWater: 1 },
};
const customer = (n: number) => ({ id: id(n), displayName: 'Synthetic contact', email: 'export@example.invalid', phone: null, archived: false, erased: false });
const full: Record<string, unknown[]> = {
  configuration: [configuration],
  resources: [{ id: id(4), name: 'Synthetic resource', timeZone: 'UTC', capacity: 1, archived: true, hours: { windows: [{ weekday: 1, start: '09:00', end: '24:00' }] } }],
  offerings: [{ id: id(5), name: 'Synthetic offering', resourceId: id(4), durationMinutes: 30, archived: true }],
  customers: [customer(6)],
  bookings: [{ id: id(7), offeringId: id(5), resourceId: id(4), customerId: id(6), start: '2026-11-02T09:00:00Z', end: '2026-11-02T09:30:00Z', status: 'cancelled' }],
  events: [{ id: id(8), sequence: 1, type: 'booking.cancelled', bookingId: id(7), occurredAt: asOf }],
  webhooks: [{ id: id(9), url: 'https://receiver.example/private-synthetic-path', enabled: false, createdAt: asOf }],
  deliveries: [{ id: id(10), subscriptionId: id(9), eventId: id(8), state: 'suppressed', createdAt: asOf, attempts: 1, maxAttempts: 5, nextAttemptAt: null, leaseExpiresAt: null, lastAttemptAt: asOf, lastOutcome: 'disabled_unknown', lastHttpStatus: null }],
  'usage-history': [{ month: '2026-09', bookingCreates: 7 }],
};
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
function transport(records = full, change?: (body: any, call: number) => unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    const params = new URL(url).searchParams, section = params.get('section')!, after = params.get('after'), limit = Number(params.get('limit'));
    let rows = records[section] ?? [];
    const key = (row: any) => String(section === 'events' ? row.sequence : section === 'usage-history' ? row.month : row.id);
    if (after) rows = rows.filter(row => section === 'events' ? Number(key(row)) > Number(after) : key(row) > after);
    const items = rows.slice(0, limit), nextAfter = rows.length > limit ? key(items.at(-1)) : null;
    const body = { schemaVersion: 1, scope, section, asOf, consistency: 'per-response', items, nextAfter };
    return response(change ? change(body, calls.length) : body);
  };
  return { fetch, calls };
}
const config = (fetch: Fetch) => ({ baseUrl: 'https://api.example.invalid', workspaceId: scope.workspaceId, credential, fetch });
async function directory(run: (path: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'availkit-business-export-'));
  try { await run(path); } finally { await rm(path, { recursive: true, force: true }); }
}
test('private complete export joins stable business/contact/history/configuration links', async () => {
  const tx = transport(), result = await businessExportText(config(tx.fetch));
  const lines = result.text.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines[0], { type: 'header', data: { schemaVersion: 1, scope, consistency: 'per-response', startedAt: asOf } });
  for (const section of businessExportSections) assert.deepEqual(lines.filter(line => line.type === section).map(line => line.data), full[section]);
  assert.equal(result.summary.requests, 9); assert.equal(result.summary.records, 9);
  assert.equal(result.summary.bytes, Buffer.byteLength(result.text));
  assert.equal(lines.at(-1).data.recordCount, 9); assert.equal(lines.at(-1).data.requestCount, 9);
  assert.equal(lines.at(-1).data.bytesBeforeEnd, Buffer.byteLength(lines.slice(0, -1).map(line => JSON.stringify(line) + '\n').join('')));
  assert(!result.text.includes(credential));
  for (const { url, init } of tx.calls) {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal((init.headers as any).Authorization, 'Bearer ' + credential);
    assert(!url.includes(credential)); assert.equal(init.body, undefined);
  }
});
test('empty environment still exports explicit configuration and all nine finished sections', async () => {
  const records = Object.fromEntries(businessExportSections.map(section => [section, section === 'configuration' ? [configuration] : []]));
  const tx = transport(records), result = await businessExportText(config(tx.fetch));
  assert.equal(result.summary.records, 1); assert.equal(result.summary.requests, 9);
  const end = JSON.parse(result.text.trimEnd().split('\n').at(-1)!);
  assert.deepEqual(end.data.counts, Object.fromEntries(businessExportSections.map(section => [section, section === 'configuration' ? 1 : 0])));
});
test('100-plus contact pagination is serial, exact and includes archived/erased retained rows', async () => {
  const contacts = Array.from({ length: 101 }, (_, i) => customer(100 + i));
  contacts[0] = { ...contacts[0], archived: true };
  contacts[1] = { ...contacts[1], displayName: 'Erased customer', email: null as any, archived: true, erased: true };
  const tx = transport({ ...full, customers: contacts }), result = await businessExportText(config(tx.fetch));
  assert.equal(result.summary.requests, 10);
  const rows = result.text.trimEnd().split('\n').map(line => JSON.parse(line)).filter(line => line.type === 'customers').map(line => line.data);
  assert.deepEqual(rows, contacts);
  const calls = tx.calls.filter(call => new URL(call.url).searchParams.get('section') === 'customers');
  assert.equal(new URL(calls[1].url).searchParams.get('after'), contacts[99].id);
});
test('same-origin dashboard routing uses session authority and no bearer', async () => {
  const tx = transport(), client = new BusinessExportClient({ baseUrl: 'https://app.example.invalid', workspaceId: scope.workspaceId, fetch: tx.fetch,
    browserSession: { environment: 'test', csrfToken: 'a'.repeat(43), principal: id(12) } });
  await client.getPage('configuration');
  assert.equal(new URL(tx.calls[0].url).pathname, `/v1/dashboard/test/workspaces/${scope.workspaceId}/export`);
  assert.equal(tx.calls[0].init.credentials, 'same-origin'); assert.equal((tx.calls[0].init.headers as any).Authorization, undefined);
  assert.equal((tx.calls[0].init.headers as any)['X-AvailKit-Dashboard-Scope'], id(12));
});
test('scope, response types, private fields, broken cursors and missing no-store fail closed without retry', async () => {
  const invalid = [
    (body: any) => ({ ...body, scope: { ...scope, workspaceId: id(999) } }),
    (body: any) => ({ ...body, scope: { ...scope, environment: 'other' } }),
    (body: any) => ({ ...body, internal: 'private' }),
    (body: any) => ({ ...body, items: [{ ...configuration, signingSecret: 'private' }] }),
    (body: any) => ({ ...body, items: [] }),
    (body: any) => ({ ...body, nextAfter: id(1) }),
    (body: any) => ({ ...body, asOf: '2026-02-30T09:00:00Z' }),
  ];
  for (const change of invalid) { const tx = transport(full, change); await assert.rejects(businessExportText(config(tx.fetch)), BusinessExportError); assert.equal(tx.calls.length, 1); }
  let calls = 0;
  await assert.rejects(new BusinessExportClient(config(async () => { calls++; return new Response('{}', { headers: { 'content-type': 'application/json' } }); })).getPage('customers'), BusinessExportError);
  assert.equal(calls, 1);
});
test('changed scope between valid pages fails the overall traversal', async () => {
  const tx = transport(full, (body, n) => n === 2 ? { ...body, scope: { ...scope, organizationId: id(999) } } : body);
  await assert.rejects(businessExportText(config(tx.fetch)), BusinessExportError); assert.equal(tx.calls.length, 2);
});
test('invalid query, options and credential values send no HTTP', async () => {
  const tx = transport(), client = new BusinessExportClient(config(tx.fetch));
  for (const query of [{ limit: 0 }, { limit: 101 }, { after: 'bad' }, { after: id(1), extra: true }] as any[]) await assert.rejects(client.getPage('resources', query), BusinessExportError);
  await assert.rejects(client.getPage('configuration', { after: id(1) }), BusinessExportError);
  await assert.rejects(client.getPage('events', { after: '01' }), BusinessExportError);
  await assert.rejects(client.getPage('usage-history', { after: '2026-13' }), BusinessExportError);
  await assert.rejects(businessExportText(config(tx.fetch), { maxCalls: 2049 }), BusinessExportError);
  assert.equal(tx.calls.length, 0);
});
test('permissions/reflected service errors remain fixed and stop after one request', async () => {
  let calls = 0;
  const fetch: Fetch = async () => { calls++; return response({ error: { code: credential, message: credential } }, 403); };
  await assert.rejects(businessExportText(config(fetch)), error => error instanceof BusinessExportError && !String(error).includes(credential));
  assert.equal(calls, 1);
});
test('exclusive actual 0600 file is complete only after sync and close', async () => directory(async dir => {
  const tx = transport(), target = join(dir, 'business.jsonl'), result = await exportBusinessFile(target, config(tx.fetch));
  const bytes = await readFile(target, 'utf8');
  assert.equal((await stat(target)).mode & 0o777, 0o600); assert.equal(result.bytes, Buffer.byteLength(bytes));
  assert.equal(JSON.parse(bytes.trimEnd().split('\n').at(-1)!).type, 'end');
  const before = tx.calls.length;
  await assert.rejects(exportBusinessFile(target, config(tx.fetch)), BusinessExportError); assert.equal(tx.calls.length, before); assert.equal(await readFile(target, 'utf8'), bytes);
}));
test('symlink target is refused before HTTP and not altered', async () => directory(async dir => {
  const tx = transport(), target = join(dir, 'original'), link = join(dir, 'link');
  await writeFile(target, 'existing', { mode: 0o600 }); await symlink(target, link);
  await assert.rejects(exportBusinessFile(link, config(tx.fetch)), BusinessExportError); assert.equal(tx.calls.length, 0); assert.equal(await readFile(target, 'utf8'), 'existing');
}));
test('Node credential-file resolver validates private source before output or HTTP', async () => directory(async dir => {
  const key = join(dir, 'private.key'), output = join(dir, 'business.jsonl'), tx = transport();
  await writeFile(key, credential + '\n', { mode: 0o600 });
  const result = await exportBusinessFile(output, { baseUrl: 'https://api.example.invalid', workspaceId: scope.workspaceId, credentialFile: key, fetch: tx.fetch });
  assert.equal(result.requests, 9); assert(!String(await readFile(output)).includes(credential));
  await chmod(key, 0o644); const before = tx.calls.length;
  await assert.rejects(exportBusinessFile(join(dir, 'unsafe.jsonl'), { baseUrl: 'https://api.example.invalid', workspaceId: scope.workspaceId, credentialFile: key, fetch: tx.fetch }), BusinessExportError);
  assert.equal(tx.calls.length, before); await assert.rejects(stat(join(dir, 'unsafe.jsonl')));
}));
test('bounded calls, disk failure and post-end sync failure keep private incomplete files', async () => directory(async dir => {
  const tx = transport(), path = join(dir, 'bounded');
  await assert.rejects(exportBusinessFile(path, config(tx.fetch), { maxCalls: 1 }), BusinessExportError);
  assert.equal(tx.calls.length, 1); assert(!String(await readFile(path)).includes('"type":"end"')); assert.equal((await stat(path)).mode & 0o777, 0o600);
  const disk = join(dir, 'disk'); let writes = 0;
  await assert.rejects(exportBusinessFile(disk, config(transport().fetch), {}, { reserve: async path => {
    const file = await open(path, 'wx', 0o600);
    return { stat: () => file.stat(), chmod: n => file.chmod(n), sync: () => file.sync(), close: () => file.close(), write: async (...args) => { if (++writes === 2) throw Error(credential); return file.write(...args); } };
  } }), BusinessExportError);
  assert.equal(writes, 2); assert(!String(await readFile(disk)).includes('"type":"end"'));
  const synced = join(dir, 'sync'); let closes = 0;
  await assert.rejects(exportBusinessFile(synced, config(transport().fetch), {}, { reserve: async path => {
    const file = await open(path, 'wx', 0o600);
    return { stat: () => file.stat(), chmod: n => file.chmod(n), sync: async () => { throw Error(credential); }, close: async () => { closes++; await file.close(); }, write: (...args) => file.write(...args) };
  } }), BusinessExportError);
  assert(String(await readFile(synced)).includes('"type":"end"')); assert.equal(closes, 1);
}));
test('real descriptor partial writes are awaited without truncation', async () => directory(async dir => {
  const path = join(dir, 'partial'), tx = transport();
  const result = await exportBusinessFile(path, config(tx.fetch), {}, { reserve: async path => {
    const file = await open(path, 'wx', 0o600);
    return { stat: () => file.stat(), chmod: n => file.chmod(n), sync: () => file.sync(), close: () => file.close(), write: (buffer, offset, length, position) => file.write(buffer, offset, Math.min(length, 7), position) };
  } });
  assert.equal((await stat(path)).size, result.bytes); assert.equal(JSON.parse(String(await readFile(path)).trimEnd().split('\n').at(-1)!).type, 'end');
}));
test('CLI argument parser rejects duplicate, unknown, unsafe and incomplete input', () => {
  assert.deepEqual(parseBusinessExportArgs(['new.jsonl', '--work-seconds', '60', '--max-calls', '2048']), { output: 'new.jsonl', options: { workSeconds: 60, maxCalls: 2048 } });
  for (const args of [[], [''], ['x\0y'], ['x', '--unknown', '1'], ['x', '--max-calls'], ['x', '--max-calls', '1', '--max-calls', '2'], ['x', '--work-seconds', '61']]) assert.throws(() => parseBusinessExportArgs(args), BusinessExportError);
});
