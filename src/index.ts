import { AvailKitError } from './errors.ts';
import { JsonTransport } from './transport.ts';
export { AvailKitError } from './errors.ts';
import {isBookingPageSettings} from './public.ts';
import type {BookingPageSettings,BookingPageInput} from './public.ts';
export {PublicBookingClient,newGuestToken} from './public.ts';
export type {PublicPage,PublicOffering,PublicBooking,PublicBookingInput,PublicClientOptions,BookingPageSettings,BookingPageInput} from './public.ts';
export { HumanClient, RecoveryClient } from './human.ts';
export type { RecoveryClientOptions, RecoveryProfileV2, RecoveryStartV2, RecoveryFinishV2 } from './human.ts';
export interface ResourceInput { name: string; timeZone: string; capacity: number }
export interface Resource extends ResourceInput { id: string; archived: boolean }
export interface HoursWindow { weekday: number; start: string; end: string }
export interface Hours { windows: HoursWindow[] }
export interface OfferingInput { name: string; resourceId: string; durationMinutes: number }
export interface Offering extends OfferingInput { id: string; archived: boolean }
export interface AvailabilityQuery { offeringId: string; from: string; to: string }
export interface Slot { start: string; end: string; remainingCapacity: number }
export interface Availability { slots: Slot[] }
export interface BookingInput { offeringId: string; start: string; customerId?: string }
export interface CustomerInput { displayName: string; email?: string | null; phone?: string | null }
export interface Customer { id: string; displayName: string; email: string | null; phone: string | null; archived: boolean; erased?: true }
export interface CustomerErasure { id: string; erased: true }
export interface RescheduleInput { expectedStart: string; start: string }
export interface Booking extends BookingInput {
  id: string; resourceId: string; end: string; status: 'confirmed' | 'cancelled';
}
export interface BookingEvent {
  id: string; sequence: number; type: 'booking.created' | 'booking.cancelled' | 'booking.rescheduled';
  bookingId: string; occurredAt: string;
}
export interface EventPage { events: BookingEvent[]; nextAfter: number; retentionFloor: number; highWater: number }
export interface EventsQuery { after?: number; limit?: number }
export interface ReplayPruneResult { asOf: string; deleted: number; hasMore: boolean }
export interface PageQuery { after?: string; limit?: number }
export interface SearchPageQuery extends PageQuery { q?: string }
export interface IterationOptions { maxPages?: number }
export type HistoryKind = 'deliveries' | 'events' | 'bookings';
export interface HistoryPruneResult extends ReplayPruneResult { cutoff: string }
export interface Page<T> { items: T[]; nextAfter: string | null }
export interface UsageCounter { used: number; limit: number; remaining: number }
export interface Usage {
  asOf: string;
  period: { start: string; end: string };
  counters: {
    monthlyBookingCreates: UsageCounter; catalogObjects: UsageCounter;
    bookingRecords: UsageCounter; committedEvents: UsageCounter;
    webhookSubscriptions: UsageCounter; webhookDeliveries: UsageCounter;
    liveReplays: UsageCounter; customerRecords: UsageCounter;
  };
}
export interface WebhookInput { url: string }
export interface Webhook extends WebhookInput { id: string; enabled: boolean; createdAt: string }
/** One-time response: deliberately contains a secret. Do not log or serialize to diagnostics. */
export interface WebhookCreated extends Webhook { signingSecret: string }
export type WebhookDeliveryState = 'pending' | 'suppressed' | 'leased' | 'sending' | 'delivered' | 'dead';
export type WebhookDeliveryOutcome = 'admitted_unknown' | 'claim_expired' | 'lease_expired_unknown' | 'disabled_unknown' | 'not_attempted' | 'invalid_target' | 'invalid_delivery' | 'address_denied' | 'transport_unknown' | 'deadline_unknown' | 'http_drained' | 'http_body_failed' | 'http_body_deadline' | 'http_body_too_large';
export interface WebhookDelivery {
  id: string; subscriptionId: string; eventId: string; createdAt: string;
  state: WebhookDeliveryState; attempts: number; maxAttempts: 5;
  nextAttemptAt: string | null; leaseExpiresAt: string | null; lastAttemptAt: string | null;
  lastOutcome: WebhookDeliveryOutcome | null; lastHttpStatus: number | null;
}
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export type ClientOptions = {
  baseUrl: string; workspaceId: string;
  fetch?: Fetch; timeoutMs?: number; maxResponseBytes?: number;
} & ({ credential: string; browserSession?: never } | {
  credential?: never;
  /** Account dashboard only: same-origin session cookies and explicit CSRF. */
  browserSession: { environment: 'test' | 'live'; csrfToken: string; principal: string };
});

function input(code: string): never { throw new AvailKitError('input', code); }
function segment(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value) || value === '.' || value === '..') input('invalid_id');
  return encodeURIComponent(value);
}
function key(value: string): string {
  if (typeof value !== 'string' || !/^[\x20-\x7e]{16,128}$/.test(value) || value.trim() !== value) input('invalid_idempotency_key');
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) > 0;
const sequence = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
const instant = (x: unknown): x is string => str(x) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(x) && Number.isFinite(Date.parse(x));
const resource = (x: unknown): x is Resource => record(x) && str(x.id) && str(x.name) && str(x.timeZone) && positive(x.capacity) && x.capacity <= 1000 && typeof x.archived === 'boolean';
const offering = (x: unknown): x is Offering => record(x) && str(x.id) && str(x.name) && str(x.resourceId) && positive(x.durationMinutes) && x.durationMinutes <= 1440 && typeof x.archived === 'boolean';
const booking = (x: unknown): x is Booking => record(x) && str(x.id) && str(x.offeringId) && str(x.resourceId) && instant(x.start) && instant(x.end) && Date.parse(x.end) > Date.parse(x.start) && (!Object.hasOwn(x, 'customerId') || webhookId(x.customerId)) && (x.status === 'confirmed' || x.status === 'cancelled');
const time = (x: unknown): x is string => typeof x === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(x);
const hours = (x: unknown): x is Hours => record(x) && Array.isArray(x.windows) && x.windows.length <= 28 && x.windows.every(w => record(w) && positive(w.weekday) && w.weekday <= 7 && time(w.start) && (time(w.end) || w.end === '24:00') && w.start < w.end);
const availability = (x: unknown): x is Availability => record(x) && Array.isArray(x.slots) && x.slots.length <= 256 && x.slots.every(s => record(s) && instant(s.start) && instant(s.end) && Date.parse(s.end) > Date.parse(s.start) && positive(s.remainingCapacity));
const eventPage = (x: unknown): x is EventPage => record(x) && Array.isArray(x.events) && x.events.length <= 100 && sequence(x.nextAfter) && x.events.every(e => record(e) && str(e.id) && positive(e.sequence) && str(e.bookingId) && instant(e.occurredAt) && (e.type === 'booking.created' || e.type === 'booking.cancelled' || e.type === 'booking.rescheduled'));
function page<T extends { id: string }>(valid: (x: unknown) => x is T, query: PageQuery) {
  const limit = query.limit ?? 25;
  return (x: unknown): x is Page<T> => {
    if (!record(x) || !Array.isArray(x.items) || x.items.length > limit || !x.items.every(valid)) return false;
    const items = x.items as T[];
    // Cursors must advance, and the server only emits one for a full page.
    if (x.nextAfter !== null && (!str(x.nextAfter) || items.length !== limit || x.nextAfter !== items.at(-1)?.id)) return false;
    return items.every((item, i) => item.id > (i ? items[i - 1].id : query.after ?? ''));
  };
}
function pageParams(query: SearchPageQuery, search = false): string {
  if (Object.keys(query).some(k => k !== 'after' && k !== 'limit' && !(search && k === 'q'))) input('invalid_query');
  if (query.after !== undefined) segment(query.after);
  if (query.limit !== undefined && (!positive(query.limit) || query.limit > 100)) input('invalid_limit');
  const params = new URLSearchParams();
  if (query.after !== undefined) params.set('after', query.after);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.q !== undefined) {
    if (typeof query.q !== 'string' || !query.q.trim() || [...query.q].length > 160 || /\p{Cc}/u.test(query.q)) input('invalid_query');
    params.set('q', query.q);
  }
  return params.size ? `?${params}` : '';
}

const webhookId = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x);
function webhookSegment(value: string): string {
  if (!webhookId(value)) input('invalid_id');
  return value;
}
const exact = (x: Record<string, unknown>, keys: readonly string[]) => Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
// Customer contacts are a closed, bounded shape. Errors never reflect field values.
const contactText = (x: unknown, max: number): x is string => typeof x === 'string' && [...x].length <= max && !/\p{Cc}/u.test(x);
const customerName = (x: unknown): x is string => contactText(x, 160) && Boolean(x.trim());
const customerEmail = (x: unknown): x is string | null => x === null || contactText(x, 254) && /^[^@\s]+@[^@\s]+$/u.test(x);
const customerPhone = (x: unknown): x is string | null => x === null || contactText(x, 32) && x.length > 0 && !/[^\S ]/u.test(x);
const customer = (x: unknown): x is Customer => record(x)
  && exact(x, Object.hasOwn(x, 'erased') ? ['id', 'displayName', 'email', 'phone', 'archived', 'erased'] : ['id', 'displayName', 'email', 'phone', 'archived'])
  && webhookId(x.id) && customerName(x.displayName) && customerEmail(x.email) && customerPhone(x.phone) && typeof x.archived === 'boolean'
  && (!Object.hasOwn(x, 'erased') || x.erased === true && x.displayName === 'Erased customer' && x.email === null && x.phone === null && x.archived === true);
const customerErasure = (id: string) => (x: unknown): x is CustomerErasure => record(x)
  && exact(x, ['id', 'erased']) && x.id === id && x.erased === true;
export function customerInput(body: CustomerInput): Readonly<CustomerInput> {
  if (!record(body) || Object.keys(body).some(k => !['displayName', 'email', 'phone'].includes(k)) || !customerName(body.displayName)
    || Object.hasOwn(body, 'email') && !customerEmail(body.email) || Object.hasOwn(body, 'phone') && !customerPhone(body.phone)) input('invalid_customer');
  return Object.freeze({ displayName: body.displayName, ...(Object.hasOwn(body, 'email') ? { email: body.email } : {}), ...(Object.hasOwn(body, 'phone') ? { phone: body.phone } : {}) });
}
const usageCounterKeys = ['monthlyBookingCreates', 'catalogObjects', 'bookingRecords', 'committedEvents', 'webhookSubscriptions', 'webhookDeliveries', 'liveReplays', 'customerRecords'];
// Date.parse normalizes impossible days (e.g. February 30); require round-trip calendar fields.
const usageInstant = (x: unknown): x is string => instant(x) && new Date(x).toISOString().slice(0, 19) === x.slice(0, 19);
const replayPruneResult = (limit: number) => (x: unknown): x is ReplayPruneResult => record(x)
  && exact(x, ['asOf', 'deleted', 'hasMore']) && usageInstant(x.asOf) && x.asOf.endsWith('Z')
  && sequence(x.deleted) && x.deleted <= limit && typeof x.hasMore === 'boolean'
  && (!x.hasMore || x.deleted === limit);
function usage(x: unknown): x is Usage {
  if (!record(x) || !exact(x, ['asOf', 'period', 'counters']) || !usageInstant(x.asOf)
    || !record(x.period) || !exact(x.period, ['start', 'end'])
    || !usageInstant(x.period.start) || !usageInstant(x.period.end)
    || !record(x.counters) || !exact(x.counters, usageCounterKeys)) return false;
  const asOf = new Date(x.asOf);
  const start = new Date(asOf);
  start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  if (Date.parse(x.period.start) !== start.getTime() || Date.parse(x.period.end) !== end.getTime()
    || !/^\d{4}-\d\d-01T00:00:00(?:\.0+)?Z$/.test(x.period.start)
    || !/^\d{4}-\d\d-01T00:00:00(?:\.0+)?Z$/.test(x.period.end)) return false;
  const counters = x.counters;
  return usageCounterKeys.every(k => {
    const c = counters[k];
    return record(c) && exact(c, ['used', 'limit', 'remaining']) && sequence(c.used) && sequence(c.limit)
      && sequence(c.remaining) && c.remaining === Math.max(0, c.limit - c.used);
  });
}
const webhookKeys = ['id', 'url', 'enabled', 'createdAt'];
const webhookFields = (x: unknown): x is Webhook => record(x) && webhookId(x.id) && typeof x.url === 'string' && typeof x.enabled === 'boolean' && instant(x.createdAt);
const webhook = (x: unknown): x is Webhook => webhookFields(x) && exact(x as unknown as Record<string, unknown>, webhookKeys);
const webhookCreated = (x: unknown): x is WebhookCreated => webhookFields(x) && record(x) && exact(x, [...webhookKeys, 'signingSecret']) && typeof x.signingSecret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x.signingSecret);
const deliveryStates: readonly string[] = ['pending', 'suppressed', 'leased', 'sending', 'delivered', 'dead'];
const deliveryOutcomes: readonly string[] = ['admitted_unknown', 'claim_expired', 'lease_expired_unknown', 'disabled_unknown', 'not_attempted', 'invalid_target', 'invalid_delivery', 'address_denied', 'transport_unknown', 'deadline_unknown', 'http_drained', 'http_body_failed', 'http_body_deadline', 'http_body_too_large'];
const deliveryKeys = ['id', 'subscriptionId', 'eventId', 'state', 'createdAt', 'attempts', 'maxAttempts', 'nextAttemptAt', 'leaseExpiresAt', 'lastAttemptAt', 'lastOutcome', 'lastHttpStatus'];
const nullableInstant = (x: unknown) => x === null || instant(x);
const delivery = (x: unknown): x is WebhookDelivery => record(x) && exact(x, deliveryKeys) && webhookId(x.id) && webhookId(x.subscriptionId) && webhookId(x.eventId) && instant(x.createdAt)
  && typeof x.state === 'string' && deliveryStates.includes(x.state) && sequence(x.attempts) && x.attempts <= 5 && x.maxAttempts === 5
  && nullableInstant(x.nextAttemptAt) && nullableInstant(x.leaseExpiresAt) && nullableInstant(x.lastAttemptAt)
  && (x.lastOutcome === null || typeof x.lastOutcome === 'string' && deliveryOutcomes.includes(x.lastOutcome))
  && (x.lastHttpStatus === null || positive(x.lastHttpStatus) && x.lastHttpStatus >= 100 && x.lastHttpStatus <= 599);
function webhookPageParams(query: SearchPageQuery, search = false): string {
  if (query.after !== undefined) webhookSegment(query.after);
  return pageParams(query, search);
}
function webhookPage<T extends { id: string }>(valid: (x: unknown) => x is T, query: PageQuery) {
  const validPage = page(valid, query);
  return (x: unknown): x is Page<T> => record(x) && exact(x, ['items', 'nextAfter']) && validPage(x);
}
/** A workspace-bound client. Each call sends once; callers control retry intent. */
export class AvailKitClient {
  #root: string;
  #fetch: Fetch;
  #timeout: number;
  #maxBytes: number;
  #http: JsonTransport;
  constructor(options: ClientOptions) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { input('invalid_base_url'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) input('invalid_base_url');
    const session=options.browserSession;
    if(session) {
      if(options.credential!==undefined || url.pathname!=='/' || typeof location!=='undefined' && url.origin!==location.origin
        || !['test','live'].includes(session.environment) || !/^[A-Za-z0-9_-]{43}$/.test(session.csrfToken) || !/^[0-9a-f]{32}$/.test(session.principal)) input('invalid_credential');
      this.#root=`${url.origin}/v1/dashboard/${session.environment}/workspaces/${segment(options.workspaceId)}`;
    } else {
      if (!str(options.credential) || /[\s\x00-\x1f\x7f]/.test(options.credential)) input('invalid_credential');
      this.#root = `${url.href.replace(/\/$/, '')}/v1/workspaces/${segment(options.workspaceId)}`;
    }
    // Native browser fetch requires its global receiver; injected transports stay unchanged.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeout = options.timeoutMs ?? 10_000;
    this.#maxBytes = options.maxResponseBytes ?? 1_048_576;
    if (!positive(this.#timeout) || this.#timeout > 120_000 || !positive(this.#maxBytes) || this.#maxBytes > 8_388_608) input('invalid_limits');
    this.#http = new JsonTransport({ baseUrl: this.#root, fetch: (url, init) => this.#fetch(url, init), headers: session ? {'X-CSRF-Token':session.csrfToken,'X-AvailKit-Dashboard-Scope':session.principal} : { Authorization: `Bearer ${options.credential}` }, credentials: session ? 'same-origin' : 'omit', timeoutMs: this.#timeout, maxResponseBytes: this.#maxBytes });
  }
  getBookingPage():Promise<BookingPageSettings> { return this.#request('GET','/booking-page',200,isBookingPageSettings); }
  replaceBookingPage(body:BookingPageInput):Promise<BookingPageSettings> {
    if(!record(body)||!exact(body as unknown as Record<string,unknown>,['title','enabled'])||!customerName(body.title)||typeof body.enabled!=='boolean') input('invalid_input');
    const frozen=Object.freeze({title:body.title,enabled:body.enabled});
    return this.#request('PUT','/booking-page',200,(v):v is BookingPageSettings=>isBookingPageSettings(v)&&v.title===frozen.title&&v.enabled===frozen.enabled&&!v.needsRepublish,frozen);
  }
  /** Secret MANAGE. Customer writes send once, without an idempotency key. */
  createCustomer(body: CustomerInput): Promise<Customer> {
    const frozen = customerInput(body);
    return this.#request('POST', '/customers', 201, (x): x is Customer => customer(x) && !x.archived
      && x.displayName === frozen.displayName && x.email === (frozen.email ?? null) && x.phone === (frozen.phone ?? null), frozen);
  }
  listCustomers(query: SearchPageQuery = {}): Promise<Page<Customer>> {
    return this.#request('GET', `/customers${webhookPageParams(query, true)}`, 200, webhookPage(customer, { ...query }));
  }
  getCustomer(customerId: string): Promise<Customer> {
    const id = webhookSegment(customerId);
    return this.#request('GET', `/customers/${id}`, 200, (x): x is Customer => customer(x) && x.id === id);
  }
  /** Full replacement: omitted email/phone clear the saved contact. */
  replaceCustomer(customerId: string, body: CustomerInput): Promise<Customer> {
    const id = webhookSegment(customerId), frozen = customerInput(body);
    return this.#request('PUT', `/customers/${id}`, 200, (x): x is Customer => customer(x) && x.id === id && !x.archived
      && x.displayName === frozen.displayName && x.email === (frozen.email ?? null) && x.phone === (frozen.phone ?? null), frozen);
  }
  archiveCustomer(customerId: string): Promise<Customer> {
    const id = webhookSegment(customerId);
    return this.#request('POST', `/customers/${id}/archive`, 200, (x): x is Customer => customer(x) && x.id === id && x.archived, {});
  }
  /** Secret MANAGE+PRIVACY. Irreversible current-contact erasure; send once, no replay key.
   * A lost response may have committed. Historical links, receipts and copies remain.
   */
  eraseCustomer(customerId: string): Promise<CustomerErasure> {
    const id = webhookSegment(customerId);
    return this.#request('POST', `/customers/${id}/erase`, 200, customerErasure(id), {});
  }
  createResource(body: ResourceInput): Promise<Resource> {
    return this.#request('POST', '/resources', 201, resource, body);
  }
  replaceResource(resourceId: string, body: ResourceInput): Promise<Resource> {
    return this.#request('PUT', `/resources/${segment(resourceId)}`, 200, (x): x is Resource => resource(x) && x.id === resourceId, body);
  }
  archiveResource(resourceId: string): Promise<Resource> {
    return this.#request('POST', `/resources/${segment(resourceId)}/archive`, 200, (x): x is Resource => resource(x) && x.id === resourceId && x.archived, {});
  }
  replaceOffering(offeringId: string, body: OfferingInput): Promise<Offering> {
    return this.#request('PUT', `/offerings/${segment(offeringId)}`, 200, (x): x is Offering => offering(x) && x.id === offeringId, body);
  }
  archiveOffering(offeringId: string): Promise<Offering> {
    return this.#request('POST', `/offerings/${segment(offeringId)}/archive`, 200, (x): x is Offering => offering(x) && x.id === offeringId && x.archived, {});
  }
  pruneHistory(kind: HistoryKind, limit: number): Promise<HistoryPruneResult> {
    if (!['deliveries', 'events', 'bookings'].includes(kind) || !positive(limit) || limit > 128) input('invalid_maintenance');
    return this.#request('POST', '/maintenance/history', 200,
      (x): x is HistoryPruneResult => record(x) && exact(x, ['asOf', 'cutoff', 'deleted', 'hasMore']) && usageInstant(x.asOf) && usageInstant(x.cutoff) && Date.parse(x.cutoff) === Date.parse(x.asOf) - 30 * 86400000 && sequence(x.deleted) && x.deleted <= limit && typeof x.hasMore === 'boolean', { kind, limit });
  }
  /** Explicit bounded read iteration; does not silently truncate an export. */
  async *pages<T extends { id: string }>(read: (query: PageQuery) => Promise<Page<T>>, query: PageQuery = {}, options: IterationOptions = {}): AsyncGenerator<Page<T>> {
    const max = options.maxPages ?? 100;
    if (!positive(max) || max > 1000) input('invalid_page_budget');
    let after = query.after;
    for (let i = 0; i < max; i++) {
      const value = await read({ ...query, after });
      if (value.nextAfter !== null && (value.nextAfter <= (after ?? '') || value.nextAfter !== value.items.at(-1)?.id)) throw new AvailKitError('protocol', 'invalid_cursor');
      yield value;
      if (value.nextAfter === null) return;
      after = value.nextAfter;
    }
    throw new AvailKitError('input', 'page_budget_exhausted');
  }
  resourcePages(query: SearchPageQuery = {}, options: IterationOptions = {}) { const fixed = { ...query }; return this.pages(q => this.listResources({ ...fixed, ...q }), fixed, { ...options }); }
  offeringPages(query: SearchPageQuery = {}, options: IterationOptions = {}) { const fixed = { ...query }; return this.pages(q => this.listOfferings({ ...fixed, ...q }), fixed, { ...options }); }
  customerPages(query: SearchPageQuery = {}, options: IterationOptions = {}) { const fixed = { ...query }; return this.pages(q => this.listCustomers({ ...fixed, ...q }), fixed, { ...options }); }
  bookingPages(query: PageQuery = {}, options: IterationOptions = {}) { return this.pages(q => this.listBookings(q), query, options); }
  webhookPages(query: PageQuery = {}, options: IterationOptions = {}) { return this.pages(q => this.listWebhooks(q), query, options); }
  deliveryPages(subscriptionId: string, query: PageQuery = {}, options: IterationOptions = {}) { return this.pages(q => this.listWebhookDeliveries(subscriptionId, q), query, options); }
  async *eventPages(query: EventsQuery = {}, options: IterationOptions = {}): AsyncGenerator<EventPage> {
    const max = options.maxPages ?? 100;
    if (!positive(max) || max > 1000) input('invalid_page_budget');
    let after = query.after ?? 0;
    for (let i = 0; i < max; i++) {
      const value = await this.events({ ...query, after }); yield value;
      if (value.events.length < (query.limit ?? 100) || value.nextAfter >= value.highWater) return;
      if (value.nextAfter <= after) throw new AvailKitError('protocol', 'invalid_cursor');
      after = value.nextAfter;
    }
    throw new AvailKitError('input', 'page_budget_exhausted');
  }
  /** Secret READ. Coherent advisory usage; this read reserves no capacity or quota. */
  getUsage(): Promise<Usage> {
    return this.#request('GET', '/usage', 200, usage);
  }
  /** Secret PRIVACY. One bounded batch; a lost response may have committed. No replay key. */
  pruneExpiredReplays(limit: number): Promise<ReplayPruneResult> {
    if (!positive(limit) || limit > 128) input('invalid_limit');
    return this.#request('POST', '/maintenance/expired-replays', 200, replayPruneResult(limit), { limit });
  }
  /** MANAGE. Sends once; there is no idempotency or secret recovery contract. */
  createWebhook(body: WebhookInput): Promise<WebhookCreated> {
    if (!record(body) || !exact(body, ['url']) || typeof body.url !== 'string' || body.url.length > 2048 || !/^[\x21-\x7e]+$/.test(body.url)) input('invalid_webhook');
    return this.#request('POST', '/webhooks', 201, webhookCreated, { url: body.url });
  }
  /** MANAGE. Returns one live page; never returns signing secrets. */
  listWebhooks(query: PageQuery = {}): Promise<Page<Webhook>> {
    return this.#request('GET', `/webhooks${webhookPageParams(query)}`, 200, webhookPage(webhook, { ...query }));
  }
  /** MANAGE. Forbids future dispatch; cannot recall an admitted network attempt. */
  disableWebhook(subscriptionId: string): Promise<Webhook> {
    const id = webhookSegment(subscriptionId);
    return this.#request('POST', `/webhooks/${id}/disable`, 200, (x): x is Webhook => webhook(x) && x.id === id && !x.enabled, {});
  }
  /** READ. Status is observation, not a request to dispatch or retry. */
  listWebhookDeliveries(subscriptionId: string, query: PageQuery = {}): Promise<Page<WebhookDelivery>> {
    const id = webhookSegment(subscriptionId);
    return this.#request('GET', `/webhooks/${id}/deliveries${webhookPageParams(query)}`, 200, webhookPage((x): x is WebhookDelivery => delivery(x) && x.subscriptionId === id, { ...query }));
  }
  listResources(query: SearchPageQuery = {}): Promise<Page<Resource>> {
    return this.#request('GET', `/resources${pageParams(query, true)}`, 200, page(resource, { ...query }));
  }
  getResource(resourceId: string): Promise<Resource> {
    return this.#request('GET', `/resources/${segment(resourceId)}`, 200, resource);
  }
  getHours(resourceId: string): Promise<Hours> {
    return this.#request('GET', `/resources/${segment(resourceId)}/hours`, 200, hours);
  }
  listOfferings(query: SearchPageQuery = {}): Promise<Page<Offering>> {
    return this.#request('GET', `/offerings${pageParams(query, true)}`, 200, page(offering, { ...query }));
  }
  getOffering(offeringId: string): Promise<Offering> {
    return this.#request('GET', `/offerings/${segment(offeringId)}`, 200, offering);
  }
  listBookings(query: PageQuery = {}): Promise<Page<Booking>> {
    return this.#request('GET', `/bookings${pageParams(query)}`, 200, page(booking, { ...query }));
  }
  getBooking(bookingId: string): Promise<Booking> {
    return this.#request('GET', `/bookings/${segment(bookingId)}`, 200, booking);
  }
  replaceHours(resourceId: string, body: Hours): Promise<Hours> {
    return this.#request('PUT', `/resources/${segment(resourceId)}/hours`, 200, hours, body);
  }
  createOffering(body: OfferingInput): Promise<Offering> {
    return this.#request('POST', '/offerings', 201, offering, body);
  }
  availability(query: AvailabilityQuery): Promise<Availability> {
    if (!instant(query.from) || !instant(query.to) || Date.parse(query.to) <= Date.parse(query.from) || Date.parse(query.to) - Date.parse(query.from) > 7 * 86_400_000) input('invalid_range');
    const params = new URLSearchParams({ offeringId: query.offeringId, from: query.from, to: query.to });
    return this.#request('GET', `/availability?${params}`, 200, availability);
  }
  book(body: BookingInput, idempotencyKey: string): Promise<Booking> {
    if (!record(body) || Object.hasOwn(body, 'customerId') && !webhookId(body.customerId)) input('invalid_customer');
    const frozen = { ...body };
    return this.#request('POST', '/bookings', 201, (x): x is Booking => booking(x) && x.status === 'confirmed' && x.customerId === frozen.customerId, frozen, key(idempotencyKey));
  }
  cancel(bookingId: string, idempotencyKey: string): Promise<Booking> {
    return this.#request('POST', `/bookings/${segment(bookingId)}/cancel`, 200, (x): x is Booking => booking(x) && x.status === 'cancelled', {}, key(idempotencyKey));
  }
  /** Secret BOOK. Keep this input/key for explicit replay after an uncertain result.
   * expectedStart compares the current start; it is not a monotonic version. */
  rescheduleBooking(bookingId: string, body: RescheduleInput, idempotencyKey: string): Promise<Booking> {
    const id = segment(bookingId);
    if (!record(body) || !exact(body, ['expectedStart', 'start']) || !usageInstant(body.expectedStart) || !usageInstant(body.start)) input('invalid_reschedule');
    return this.#request('POST', `/bookings/${id}/reschedule`, 200,
      (x): x is Booking => booking(x) && usageInstant(x.start) && usageInstant(x.end) && exact(x as unknown as Record<string, unknown>, ['id', 'offeringId', 'resourceId', 'start', 'end', 'status', ...(Object.hasOwn(x, 'customerId') ? ['customerId'] : [])]) && x.status === 'confirmed' && x.id === bookingId,
      { expectedStart: body.expectedStart, start: body.start }, key(idempotencyKey));
  }
  events(query: EventsQuery = {}): Promise<EventPage> {
    if (query.after !== undefined && !sequence(query.after)) input('invalid_cursor');
    if (query.limit !== undefined && (!positive(query.limit) || query.limit > 100)) input('invalid_limit');
    const params = new URLSearchParams();
    if (query.after !== undefined) params.set('after', String(query.after));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const after = query.after ?? 0, limit = query.limit ?? 100;
    return this.#request('GET', `/events${params.size ? `?${params}` : ''}`, 200,
      (x): x is EventPage => eventPage(x) && sequence(x.retentionFloor) && sequence(x.highWater) && x.retentionFloor <= x.highWater && x.nextAfter <= Math.max(x.highWater, after) && x.events.length <= limit
        && x.events.every((e, i) => e.sequence > (i ? x.events[i - 1].sequence : Math.max(after, x.retentionFloor)))
        && x.nextAfter === (x.events.at(-1)?.sequence ?? Math.max(after, x.retentionFloor)));

  }
  #request<T>(method: string, path: string, status: number, valid: (x: unknown) => x is T, body?: unknown, intentKey?: string): Promise<T> {
    return this.#http.request(method, path, status, valid, body, intentKey);
  }
}
