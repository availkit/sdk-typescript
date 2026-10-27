import { AvailKitClient } from './index.ts';
import type { ClientOptions } from './index.ts';
import { JsonTransport } from './transport.ts';

export const businessExportSections = ['configuration', 'resources', 'offerings', 'customers', 'bookings', 'events', 'webhooks', 'deliveries', 'usage-history'] as const;
export type BusinessExportSection = typeof businessExportSections[number];
export type BusinessExportScope = { organizationId: string; workspaceId: string; environment: 'test' | 'live' };
type Obj = Record<string, unknown>;
export interface BusinessExportPage {
  schemaVersion: 1; scope: BusinessExportScope; section: BusinessExportSection;
  asOf: string; consistency: 'per-response'; items: Obj[]; nextAfter: string | null;
}
export class BusinessExportError extends Error {
  constructor() { super('AvailKit business export failed'); this.name = 'BusinessExportError'; }
}
function fail(): never { throw new BusinessExportError(); }
const object = (value: unknown): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);
function closed(value: unknown, keys: string[]): value is Obj {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const bounded = (value: unknown, lo: number, hi: number): value is number => natural(value) && value >= lo && value <= hi;
const ident = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && Boolean(value.trim()) && [...value].length <= maximum && !/\p{Cc}/u.test(value);
const instant = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const month = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
const positiveSequence = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const nullableInstant = (value: unknown) => value === null || instant(value);
function hours(value: unknown): boolean {
  return closed(value, ['windows']) && Array.isArray(value.windows) && value.windows.length <= 28 && value.windows.every(window => closed(window, ['weekday', 'start', 'end'])
    && bounded(window.weekday, 1, 7) && typeof window.start === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.start)
    && typeof window.end === 'string' && /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/.test(window.end) && window.start < window.end);
}
const counterNames = ['monthlyBookingCreates', 'catalogObjects', 'bookingRecords', 'committedEvents', 'webhookSubscriptions', 'webhookDeliveries', 'liveReplays', 'customerRecords'];
function usage(value: unknown): boolean {
  if (!closed(value, ['asOf', 'period', 'counters']) || !instant(value.asOf) || !closed(value.period, ['start', 'end'])
    || !instant(value.period.start) || !instant(value.period.end) || !closed(value.counters, counterNames)) return false;
  const start = new Date(value.asOf); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  return Date.parse(value.period.start) === +start && Date.parse(value.period.end) === +end && counterNames.every(name => {
    const counter = (value.counters as Obj)[name];
    return closed(counter, ['used', 'limit', 'remaining']) && natural(counter.used) && natural(counter.limit) && natural(counter.remaining) && counter.remaining === Math.max(0, counter.limit - counter.used);
  });
}
const deliveryStates = ['pending', 'suppressed', 'leased', 'sending', 'delivered', 'dead'];
const deliveryOutcomes = ['admitted_unknown', 'claim_expired', 'lease_expired_unknown', 'disabled_unknown', 'not_attempted', 'invalid_target', 'invalid_delivery', 'address_denied', 'transport_unknown', 'deadline_unknown', 'http_drained', 'http_body_failed', 'http_body_deadline', 'http_body_too_large'];
function item(section: BusinessExportSection, value: unknown): value is Obj {
  switch (section) {
    case 'configuration':
      return closed(value, ['bookingPage', 'usage', 'eventRetention']) && closed(value.bookingPage, ['pageId', 'title', 'enabled', 'needsRepublish'])
        && (value.bookingPage.pageId === null || ident(value.bookingPage.pageId)) && text(value.bookingPage.title, 160)
        && typeof value.bookingPage.enabled === 'boolean' && typeof value.bookingPage.needsRepublish === 'boolean' && usage(value.usage)
        && closed(value.eventRetention, ['retentionFloor', 'highWater']) && natural(value.eventRetention.retentionFloor) && natural(value.eventRetention.highWater) && value.eventRetention.retentionFloor <= value.eventRetention.highWater;
    case 'resources':
      return closed(value, ['id', 'name', 'timeZone', 'capacity', 'archived', 'hours']) && ident(value.id) && text(value.name, 160) && text(value.timeZone, 128) && bounded(value.capacity, 1, 1000) && typeof value.archived === 'boolean' && hours(value.hours);
    case 'offerings':
      return closed(value, ['id', 'name', 'resourceId', 'durationMinutes', 'archived']) && ident(value.id) && text(value.name, 160) && ident(value.resourceId) && bounded(value.durationMinutes, 1, 1440) && typeof value.archived === 'boolean';
    case 'customers':
      return closed(value, ['id', 'displayName', 'email', 'phone', 'archived', 'erased']) && ident(value.id) && text(value.displayName, 160)
        && (value.email === null || text(value.email, 254) && /^[^@\s]+@[^@\s]+$/u.test(value.email))
        && (value.phone === null || typeof value.phone === 'string' && value.phone.length > 0 && [...value.phone].length <= 32 && !/\p{Cc}/u.test(value.phone)) && typeof value.archived === 'boolean' && typeof value.erased === 'boolean'
        && (!value.erased || value.displayName === 'Erased customer' && value.email === null && value.phone === null && value.archived);
    case 'bookings':
      return object(value) && closed(value, ['id', 'offeringId', 'resourceId', 'start', 'end', 'status', ...(Object.hasOwn(value, 'customerId') ? ['customerId'] : [])])
        && ident(value.id) && ident(value.offeringId) && ident(value.resourceId) && instant(value.start) && instant(value.end) && Date.parse(value.end) > Date.parse(value.start)
        && ['confirmed', 'cancelled'].includes(String(value.status)) && (!Object.hasOwn(value, 'customerId') || ident(value.customerId));
    case 'events':
      return closed(value, ['id', 'sequence', 'type', 'bookingId', 'occurredAt']) && ident(value.id) && bounded(value.sequence, 1, Number.MAX_SAFE_INTEGER)
        && ['booking.created', 'booking.cancelled', 'booking.rescheduled'].includes(String(value.type)) && ident(value.bookingId) && instant(value.occurredAt);
    case 'webhooks':
      // URL paths are owner data and can contain target secrets. This private
      // export intentionally includes the same canonical URL MANAGE can read.
      return closed(value, ['id', 'url', 'enabled', 'createdAt']) && ident(value.id) && typeof value.url === 'string' && value.url.length <= 2048 && /^https:\/\//.test(value.url) && typeof value.enabled === 'boolean' && instant(value.createdAt);
    case 'deliveries':
      return closed(value, ['id', 'subscriptionId', 'eventId', 'state', 'createdAt', 'attempts', 'maxAttempts', 'nextAttemptAt', 'leaseExpiresAt', 'lastAttemptAt', 'lastOutcome', 'lastHttpStatus'])
        && ident(value.id) && ident(value.subscriptionId) && ident(value.eventId) && deliveryStates.includes(String(value.state)) && instant(value.createdAt) && bounded(value.attempts, 0, 5) && value.maxAttempts === 5
        && nullableInstant(value.nextAttemptAt) && nullableInstant(value.leaseExpiresAt) && nullableInstant(value.lastAttemptAt)
        && (value.lastOutcome === null || deliveryOutcomes.includes(String(value.lastOutcome))) && (value.lastHttpStatus === null || bounded(value.lastHttpStatus, 100, 599));
    case 'usage-history': return closed(value, ['month', 'bookingCreates']) && month(value.month) && natural(value.bookingCreates);
  }
}
function cursor(section: BusinessExportSection, value: unknown): value is string {
  return section === 'events' ? positiveSequence(value) : section === 'usage-history' ? month(value) : section !== 'configuration' && ident(value);
}
function key(section: BusinessExportSection, value: Obj): string {
  return String(section === 'events' ? value.sequence : section === 'usage-history' ? value.month : value.id);
}
function afterKey(section: BusinessExportSection, left: string, right: string): boolean {
  return section === 'events' ? Number(left) > Number(right) : left > right;
}
function page(value: unknown, section: BusinessExportSection, limit: number, after?: string): value is BusinessExportPage {
  if (!closed(value, ['schemaVersion', 'scope', 'section', 'asOf', 'consistency', 'items', 'nextAfter']) || value.schemaVersion !== 1 || value.section !== section
    || !closed(value.scope, ['organizationId', 'workspaceId', 'environment']) || !ident(value.scope.organizationId) || !ident(value.scope.workspaceId) || !['test', 'live'].includes(String(value.scope.environment))
    || !instant(value.asOf) || value.consistency !== 'per-response' || !Array.isArray(value.items) || value.items.length > limit || !value.items.every(value => item(section, value))) return false;
  if (section === 'configuration') return value.items.length === 1 && value.nextAfter === null;
  let previous = after ?? (section === 'events' ? '0' : '');
  for (const entry of value.items) { const current = key(section, entry); if (!afterKey(section, current, previous)) return false; previous = current; }
  return value.nextAfter === null || cursor(section, value.nextAfter) && value.items.length === limit && value.nextAfter === previous;
}

/** Private, bounded reads only. Every page repeats current server authorization. */
export class BusinessExportClient {
  #options: ClientOptions;
  constructor(options: ClientOptions) {
    new AvailKitClient(options); // Use the maintained credential/origin validation.
    if (!ident(options.workspaceId)) fail();
    this.#options = { ...options, ...(options.browserSession ? { browserSession: { ...options.browserSession } } : {}) } as ClientOptions;
  }
  async getPage(section: BusinessExportSection, query: { after?: string; limit?: number } = {}): Promise<BusinessExportPage> {
    try {
      if (!businessExportSections.includes(section) || !closed(query, Object.keys(query)) || Object.keys(query).some(name => !['after', 'limit'].includes(name))) fail();
      const limit = query.limit ?? 100;
      if (!bounded(limit, 1, 100) || query.after !== undefined && !cursor(section, query.after)) fail();
      const options = this.#options, origin = new URL(options.baseUrl), session = options.browserSession;
      const root = session ? `${origin.origin}/v1/dashboard/${session.environment}/workspaces/${options.workspaceId}` : `${origin.href.replace(/\/$/, '')}/v1/workspaces/${options.workspaceId}`;
      const params = new URLSearchParams({ section, limit: String(limit) }); if (query.after !== undefined) params.set('after', query.after);
      return await new JsonTransport({ baseUrl: root, fetch: options.fetch,
        headers: session ? { 'X-CSRF-Token': session.csrfToken, 'X-AvailKit-Dashboard-Scope': session.principal } : { Authorization: `Bearer ${options.credential}` },
        credentials: session ? 'same-origin' : 'omit', timeoutMs: options.timeoutMs, maxResponseBytes: options.maxResponseBytes, requireNoStore: true,
      }).request('GET', `/export?${params}`, 200, (value): value is BusinessExportPage => page(value, section, limit, query.after)
        && value.scope.workspaceId === options.workspaceId && (!session || value.scope.environment === session.environment));
    } catch { throw new BusinessExportError(); }
  }
}

export interface BusinessExportOptions { maxCalls?: number; workSeconds?: number }
export interface BusinessExportSummary { status: 'complete'; records: number; requests: number; bytes: number }
export interface BusinessExportDependencies {
  now?: () => number;
  /** Test seams can lower, never increase, product bounds. */
  limits?: { records?: number; bytes?: number };
}

/** Emit JSONL privately. Completion here means traversal, not saved-file durability. */
export async function traverseBusinessExport(config: ClientOptions, write: (line: string) => Promise<void>, options: BusinessExportOptions = {}, deps: BusinessExportDependencies = {}): Promise<BusinessExportSummary> {
  try {
    new BusinessExportClient(config);
    const maxCalls = options.maxCalls ?? 2048, seconds = options.workSeconds ?? 30;
    const maxRecords = deps.limits?.records ?? 50_000, maxBytes = deps.limits?.bytes ?? 32 * 1024 * 1024;
    if (!bounded(maxCalls, 1, 2048) || !bounded(seconds, 1, 60) || !bounded(maxRecords, 3, 50_000) || !bounded(maxBytes, 1, 32 * 1024 * 1024)) fail();
    const now = deps.now ?? (() => performance.now()), deadline = now() + seconds * 1000;
    const secrets = config.browserSession ? [config.browserSession.csrfToken] : [config.credential];
    let bytes = 0, lines = 0, records = 0, requests = 0;
    let scope: BusinessExportScope | undefined;
    const counts = Object.fromEntries(businessExportSections.map(section => [section, 0])) as Record<BusinessExportSection, number>;
    async function emit(type: string, data: unknown) {
      const line = JSON.stringify({ type, data }) + '\n', length = new TextEncoder().encode(line).length;
      if (secrets.some(secret => secret && (line.includes(secret) || line.includes(JSON.stringify(secret).slice(1, -1)))) || lines + 1 > maxRecords || bytes + length > maxBytes) fail();
      await write(line); bytes += length; lines++;
    }
    for (const section of businessExportSections) {
      let after: string | undefined;
      for (;;) {
        const remaining = Math.floor(deadline - now());
        if (remaining < 1 || requests >= maxCalls || lines + 3 > maxRecords) fail();
        const client = new BusinessExportClient({ ...config, timeoutMs: Math.min(config.timeoutMs ?? 10_000, remaining) });
        requests++;
        const value = await client.getPage(section, { ...(after === undefined ? {} : { after }), limit: 100 });
        if (!scope) {
          scope = value.scope;
          await emit('header', { schemaVersion: 1, scope, consistency: 'per-response', startedAt: value.asOf });
        } else if (value.scope.organizationId !== scope.organizationId || value.scope.workspaceId !== scope.workspaceId || value.scope.environment !== scope.environment) fail();
        await emit('page', { section, asOf: value.asOf, after: after ?? null, nextAfter: value.nextAfter });
        for (const data of value.items) {
          if (lines + 2 > maxRecords) fail();
          await emit(section, data); records++; counts[section]++;
        }
        if (value.nextAfter === null) break;
        if (value.nextAfter === after) fail();
        after = value.nextAfter;
      }
    }
    await emit('end', { traversalComplete: true, recordCount: records, requestCount: requests, bytesBeforeEnd: bytes, counts });
    return { status: 'complete', records, requests, bytes };
  } catch { throw new BusinessExportError(); }
}

/** Dashboard adapter: bounded in-memory text, then an explicit local download. */
export async function businessExportText(config: ClientOptions, options: BusinessExportOptions = {}): Promise<{ text: string; summary: BusinessExportSummary }> {
  const lines: string[] = [];
  const summary = await traverseBusinessExport(config, async line => { lines.push(line); }, options);
  return { text: lines.join(''), summary };
}
