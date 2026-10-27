import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AvailKitClient, AvailKitError } from '../src/index.ts';
import type { Fetch } from '../src/index.ts';

const resource = { id: 'res/one', name: 'Room', timeZone: 'Europe/London', capacity: 2, archived: false };
const offering = { id: 'off-one', name: 'Visit', resourceId: resource.id, durationMinutes: 30, archived: false };
const booking = { id: 'book-one', resourceId: resource.id, offeringId: offering.id, start: '2030-01-07T09:00:00Z', end: '2030-01-07T09:30:00Z', status: 'confirmed' };
const hours = { windows: [{ weekday: 1, start: '09:00', end: '24:00' }] };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const client = (fetch: Fetch) => new AvailKitClient({ baseUrl: 'http://localhost', workspaceId: 'workspace/one', credential: 'synthetic-only', fetch });

test('seven M2 reads use exact routes, bounded cursor queries and common authority transport', async () => {
  const seen: {url: URL; init: RequestInit}[] = [];
  const replies = [json({ items: [resource], nextAfter: resource.id }), json(resource), json(hours), json({ items: [offering], nextAfter: null }), json(offering), json({ items: [booking], nextAfter: null }), json({ ...booking, status: 'cancelled' })];
  const c = client(async (url, init) => { seen.push({ url: new URL(url), init }); return replies.shift()!; });
  assert.deepEqual(await c.listResources({ limit: 1, after: 'res/first' }), { items: [resource], nextAfter: resource.id });
  assert.deepEqual(await c.getResource(resource.id), resource);
  assert.deepEqual(await c.getHours(resource.id), hours);
  await c.listOfferings(); await c.getOffering(offering.id); await c.listBookings({ limit: 25 });
  assert.equal((await c.getBooking(booking.id)).status, 'cancelled');
  assert.deepEqual(seen.map(x => x.url.pathname.replace('/v1/workspaces/workspace%2Fone', '') + x.url.search), [
    '/resources?after=res%2Ffirst&limit=1', '/resources/res%2Fone', '/resources/res%2Fone/hours', '/offerings', '/offerings/off-one', '/bookings?limit=25', '/bookings/book-one',
  ]);
  for (const { init } of seen) {
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-only');
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'omit');
  }
});

test('bounded list reads reject invalid limits, unknown query keys and invalid cursors before sending', () => {
  let calls = 0;
  const c = client(async () => { calls++; return json({}); });
  for (const q of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { after: '' }, { after: '..' }, { unexpected: true }]) {
    assert.throws(() => c.listResources(q as never), AvailKitError);
    assert.throws(() => c.listOfferings(q as never), AvailKitError);
    assert.throws(() => c.listBookings(q as never), AvailKitError);
  }
  assert.equal(calls, 0);
});

test('pages reject excess rows, invalid representations, duplicate/order/cursor errors and false empty continuation', async () => {
  for (const data of [
    { items: [resource, resource], nextAfter: null },
    { items: [{ ...resource, capacity: 0 }], nextAfter: null },
    { items: [], nextAfter: 'res-next' },
    { items: [resource], nextAfter: 'different' },
    { items: [resource], nextAfter: 5 },
    { items: [resource] },
  ]) {
    await assert.rejects(client(async () => json(data)).listResources({ limit: 1 }), e => e instanceof AvailKitError && e.kind === 'protocol');
  }
  for (const items of [[resource, resource], [{ ...resource, id: 'z' }, resource]]) {
    await assert.rejects(client(async () => json({ items, nextAfter: null })).listResources(), AvailKitError);
  }
  await assert.rejects(client(async () => json({ items: [resource], nextAfter: null })).listResources({ after: resource.id }), AvailKitError);
  assert.deepEqual(await client(async () => json({ items: [], nextAfter: null })).listResources(), { items: [], nextAfter: null });
});

test('query snapshots cannot be changed while a page is in flight', async () => {
  const query = { limit: 1 };
  const pending = client(async () => { await Promise.resolve(); return json({ items: [resource], nextAfter: resource.id }); }).listResources(query);
  query.limit = 2;
  assert.equal((await pending).nextAfter, resource.id);
});

test('403 and 503 reads send once and omit reflected secret diagnostics', async () => {
  for (const status of [403, 503]) {
    let count = 0;
    await assert.rejects(client(async () => { count++; return json({ error: { code: 'denied', message: 'synthetic-only' } }, status); }).listBookings(), e => e instanceof AvailKitError && e.status === status && !String(e).includes('synthetic-only'));
    assert.equal(count, 1);
  }
});

test('current booking GET can be cancelled while creation replay remains confirmed', async () => {
  const c = client(async (_, init) => init.method === 'POST' ? json(booking, 201) : json({ ...booking, status: 'cancelled' }));
  assert.equal((await c.book({ offeringId: offering.id, start: booking.start }, 'same-booking-intent')).status, 'confirmed');
  assert.equal((await c.getBooking(booking.id)).status, 'cancelled');
});
