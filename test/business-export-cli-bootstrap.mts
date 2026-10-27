// Explicit test-only preload. No socket, service, credential or output is shared.
import { readFileSync, appendFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.env.AVAILKIT_BUSINESS_EXPORT_TEST_CONFIG!, 'utf8'));
const asOf = '2026-10-27T09:00:00.000Z';
const counter = { used: 0, limit: 100, remaining: 100 };
const rows: Record<string, unknown[]> = {
  configuration: [{ bookingPage: { pageId: null, title: 'CLI private synthetic page', enabled: false, needsRepublish: false },
    usage: { asOf, period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' }, counters: Object.fromEntries(['monthlyBookingCreates', 'catalogObjects', 'bookingRecords', 'committedEvents', 'webhookSubscriptions', 'webhookDeliveries', 'liveReplays', 'customerRecords'].map(name => [name, counter])) }, eventRetention: { retentionFloor: 0, highWater: 0 } }],
  customers: [{ id: '4'.repeat(32), displayName: 'CLI private synthetic contact', email: 'cli-export@example.invalid', phone: null, archived: false, erased: false }],
  webhooks: [{ id: '5'.repeat(32), url: 'https://receiver.example/private-synthetic-target', enabled: false, createdAt: asOf }],
};
globalThis.fetch = async (url, init) => {
  const parsed = new URL(String(url)), section = parsed.searchParams.get('section')!;
  appendFileSync(config.requests, JSON.stringify({ method: init?.method, section }) + '\n', { mode: 0o600 });
  if (config.mode === 'abort') return await new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted) reject(Error('private synthetic abort cause'));
    else init?.signal?.addEventListener('abort', () => reject(Error('private synthetic abort cause')), { once: true });
  });
  if (config.mode === 'refuse') return new Response(JSON.stringify({ error: { code: config.credential, message: config.credential + ' private synthetic body' } }), { status: 403, headers: { 'content-type': 'application/json' } });
  if ((init?.headers as Record<string,string>)?.Authorization !== 'Bearer ' + config.credential) throw Error('private synthetic authorization mismatch');
  return new Response(JSON.stringify({ schemaVersion: 1, scope: { organizationId: '1'.repeat(32), workspaceId: '2'.repeat(32), environment: 'test' }, section, asOf, consistency: 'per-response', items: rows[section] ?? [], nextAfter: null }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
};
