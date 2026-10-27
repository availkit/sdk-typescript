import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { AvailKitClient } from './index.ts';
import type { ClientOptions, Fetch } from './index.ts';

export const exportFailure = 'AvailKit export failed. Keep the private empty or partial file; it is incomplete. Check configuration, READ and MANAGE access, limits and disk before starting a new export. No automatic retry was sent.\n';
export class ExportError extends Error {
  constructor() { super('AvailKit export failed'); this.name = 'ExportError'; }
}
function fail(): never { throw new ExportError(); }
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
function closed(v: unknown, keys: string[]): asserts v is Obj {
  if (!object(v) || Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k))) fail();
}
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
function id(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !v.trim() || v === '.' || v === '..' || Buffer.byteLength(v) > 256) fail();
}
function instant(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 19) !== v.slice(0, 19)) fail();
}
function text(v: unknown): asserts v is string { if (typeof v !== 'string' || !v.length) fail(); }
const counterKeys = ['monthlyBookingCreates', 'catalogObjects', 'bookingRecords', 'committedEvents', 'webhookSubscriptions', 'webhookDeliveries', 'liveReplays', 'customerRecords'];
const deliveryKeys = ['id', 'subscriptionId', 'eventId', 'state', 'createdAt', 'attempts', 'maxAttempts', 'nextAttemptAt', 'leaseExpiresAt', 'lastAttemptAt', 'lastOutcome', 'lastHttpStatus'];
const dataTypes = ['usage', 'resource', 'hours', 'offering', 'booking', 'event', 'webhook', 'delivery'] as const;
type DataType = typeof dataTypes[number];

// SDK validation is necessary, but several management shapes are open. Never
// serialize a returned object, even after checking its keys: build every record.
function project(type: DataType, v: unknown, resourceId?: string): Obj {
  switch (type) {
    case 'usage': {
      closed(v, ['asOf', 'period', 'counters']); closed(v.period, ['start', 'end']); closed(v.counters, counterKeys);
      instant(v.asOf); instant(v.period.start); instant(v.period.end);
      const counters: Obj = {};
      for (const k of counterKeys) {
        const c = v.counters[k]; closed(c, ['used', 'limit', 'remaining']);
        if (!integer(c.used) || !integer(c.limit) || !integer(c.remaining) || c.remaining !== Math.max(0, c.limit - c.used)) fail();
        counters[k] = { used: c.used, limit: c.limit, remaining: c.remaining };
      }
      return { asOf: v.asOf, period: { start: v.period.start, end: v.period.end }, counters };
    }
    case 'resource':
      closed(v, ['id', 'name', 'timeZone', 'capacity', 'archived']); id(v.id); text(v.name); text(v.timeZone);
      if (!integer(v.capacity, 1)) fail();
      return { id: v.id, name: v.name, timeZone: v.timeZone, capacity: v.capacity, archived: v.archived };
    case 'hours': {
      closed(v, ['windows']); id(resourceId);
      if (!Array.isArray(v.windows) || v.windows.length > 28) fail();
      const windows = v.windows.map((w: unknown) => {
        closed(w, ['weekday', 'start', 'end']);
        if (!integer(w.weekday, 1, 7) || typeof w.start !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(w.start)
          || typeof w.end !== 'string' || !/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/.test(w.end) || w.start >= w.end) fail();
        return { weekday: w.weekday, start: w.start, end: w.end };
      });
      return { resourceId, windows };
    }
    case 'offering':
      closed(v, ['id', 'name', 'resourceId', 'durationMinutes', 'archived']); id(v.id); id(v.resourceId); text(v.name);
      if (!integer(v.durationMinutes, 1)) fail();
      return { id: v.id, name: v.name, resourceId: v.resourceId, durationMinutes: v.durationMinutes, archived: v.archived };
    case 'booking':
      closed(v, ['id', 'offeringId', 'resourceId', 'start', 'end', 'status', ...(object(v) && Object.hasOwn(v, 'customerId') ? ['customerId'] : [])]);
      if (Object.hasOwn(v, 'customerId') && (typeof v.customerId !== 'string' || !/^[0-9a-f]{32}$/.test(v.customerId))) fail();
      id(v.id); id(v.offeringId); id(v.resourceId); instant(v.start); instant(v.end);
      if (Date.parse(v.end) <= Date.parse(v.start) || (v.status !== 'confirmed' && v.status !== 'cancelled')) fail();
      return { id: v.id, offeringId: v.offeringId, resourceId: v.resourceId, start: v.start, end: v.end, status: v.status, ...(Object.hasOwn(v, 'customerId') ? { customerId: v.customerId } : {}) };
    case 'event':
      closed(v, ['id', 'sequence', 'type', 'bookingId', 'occurredAt']); id(v.id); id(v.bookingId); instant(v.occurredAt);
      if (!integer(v.sequence, 1) || (v.type !== 'booking.created' && v.type !== 'booking.cancelled' && v.type !== 'booking.rescheduled')) fail();
      return { id: v.id, sequence: v.sequence, type: v.type, bookingId: v.bookingId, occurredAt: v.occurredAt };
    case 'webhook':
      closed(v, ['id', 'url', 'enabled', 'createdAt']); id(v.id); instant(v.createdAt);
      if (typeof v.enabled !== 'boolean' || typeof v.url !== 'string') fail();
      return { id: v.id, enabled: v.enabled, createdAt: v.createdAt };
    case 'delivery':
      closed(v, deliveryKeys); id(v.id); id(v.subscriptionId); id(v.eventId); instant(v.createdAt);
      for (const k of ['nextAttemptAt', 'leaseExpiresAt', 'lastAttemptAt']) if (v[k] !== null) instant(v[k]);
      // Remaining delivery enum/counter invariants are checked by the closed SDK validator.
      return { id: v.id, subscriptionId: v.subscriptionId, eventId: v.eventId, state: v.state, createdAt: v.createdAt,
        attempts: v.attempts, maxAttempts: v.maxAttempts, nextAttemptAt: v.nextAttemptAt, leaseExpiresAt: v.leaseExpiresAt,
        lastAttemptAt: v.lastAttemptAt, lastOutcome: v.lastOutcome, lastHttpStatus: v.lastHttpStatus };
  }
}

export interface ExportOptions { output: string; maxCalls: number; workSeconds: number }
export function parseExportArgs(args: string[]): ExportOptions {
  if (!args.length || !args[0] || args[0].startsWith('--') || args[0].includes('\0')) fail();
  const result = { output: args[0], maxCalls: 2048, workSeconds: 30 };
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i], value = args[i + 1];
    if (!['--max-calls', '--work-seconds'].includes(k) || seen.has(k) || !/^[1-9]\d*$/.test(value ?? '')) fail();
    seen.add(k); const n = Number(value);
    if (!integer(n, 1, k === '--max-calls' ? 2048 : 60)) fail();
    if (k === '--max-calls') result.maxCalls = n; else result.workSeconds = n;
  }
  return result;
}

type File = Pick<Awaited<ReturnType<typeof open>>, 'stat' | 'chmod' | 'write' | 'sync' | 'close'>;
/** Test seams never change CLI/serving configuration or increase production limits. */
export interface ExportDependencies {
  fetch?: Fetch; reserve?: (path: string) => Promise<File>; now?: () => number;
  limits?: { records?: number; bytes?: number };
}
export interface ExportSummary { status: 'complete'; records: number; requests: number; bytes: number }

// The SDK timeout requests abort/cancellation; its returned Promise alone does
// not establish underlying settlement. This wrapper waits for the fetch/read/cancel
// promises it tracks, not every library/socket/transport operation. Uncooperative
// work can prevent completion; the work budget bounds read admission, not wall time.
function joinedFetch(fetch: Fetch) {
  const pending = new Set<Promise<unknown>>();
  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }
  const wrapped: Fetch = (url, init) => track((async () => {
    const response = await fetch(url, init);
    if (init.signal?.aborted) { if (response.body) await track(response.body.cancel()); fail(); }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let ended = false;
    const cancel = () => { if (!ended) return track(reader.cancel().finally(release)); };
    const onAbort = () => { void cancel()?.catch(() => {}); };
    const release = () => { if (!ended) { ended = true; init.signal?.removeEventListener('abort', onAbort); reader.releaseLock(); } };
    init.signal?.addEventListener('abort', onAbort, { once: true });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await track(reader.read());
          if (part.done) { release(); controller.close(); } else controller.enqueue(part.value);
        } catch { release(); controller.error(new ExportError()); }
      },
      cancel() { return cancel(); },
    }, { highWaterMark: 0 });
    // Preserve status/headers and redirected, including deliberately bad mocks.
    const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(result, 'redirected', { value: response.redirected });
    return result;
  })());
  return { fetch: wrapped, async join() { while (pending.size) await Promise.allSettled([...pending]); } };
}

export async function exportWorkspace(options: ExportOptions, config: Pick<Extract<ClientOptions, { credential: string }>, 'baseUrl' | 'workspaceId' | 'credential'>, deps: ExportDependencies = {}): Promise<ExportSummary> {
  let file: File | undefined, closeAttempted = false;
  const transport = joinedFetch(deps.fetch ?? globalThis.fetch);
  try {
    if (!integer(options.maxCalls, 1, 2048) || !integer(options.workSeconds, 1, 60) || !options.output || options.output.includes('\0')) fail();
    id(config.workspaceId);
    const checkSecret = (s: string) => {
      // Check literal and JSON-escaped forms, including escaped credentials in fields.
      if (s.includes(config.credential) || s.includes(JSON.stringify(config.credential).slice(1, -1))) fail();
    };
    new AvailKitClient(config); // All configuration errors stay local, before reservation.
    checkSecret(JSON.stringify(config.workspaceId));
    const now = deps.now ?? (() => performance.now());
    const deadline = now() + options.workSeconds * 1000;
    const maxRecords = deps.limits?.records ?? 50_000, maxBytes = deps.limits?.bytes ?? 32 * 1024 * 1024;
    if (!integer(maxRecords, 2, 50_000) || !integer(maxBytes, 1, 32 * 1024 * 1024)) fail();
    file = await (deps.reserve ?? (p => open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)))(options.output);
    if (!(await file.stat()).isFile()) fail();
    await file.chmod(0o600);
    const output = file; // Capture the reserved descriptor for nested writers.
    let bytes = 0, lines = 0, requests = 0, records = 0;
    const counts = Object.fromEntries(dataTypes.map(k => [k, 0])) as Record<DataType, number>;
    const ids = Object.fromEntries(dataTypes.map(k => [k, new Set<string>()])) as Record<DataType, Set<string>>;
    async function write(type: string, data: Obj) {
      const line = JSON.stringify({ type, data }) + '\n'; checkSecret(line);
      const buffer = Buffer.from(line);
      if (lines + 1 > maxRecords || bytes + buffer.length > maxBytes) fail();
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await output.write(buffer, offset, buffer.length - offset, null);
        if (!integer(bytesWritten, 1, buffer.length - offset)) fail();
        offset += bytesWritten;
      }
      bytes += buffer.length; lines++;
    }
    async function emit(type: DataType, value: unknown, parent?: string) {
      const data = project(type, value, parent);
      if (typeof data.id === 'string') {
        if (ids[type].has(data.id)) fail(); ids[type].add(data.id);
      }
      // Leave one record slot for end; bounded sets cannot exceed this ceiling.
      if (lines + 2 > maxRecords) fail();
      await write(type, data); records++; counts[type]++;
    }
    async function read<T>(operation: (client: AvailKitClient) => Promise<T>): Promise<T> {
      const remaining = Math.floor(deadline - now());
      if (remaining < 1 || requests >= options.maxCalls || lines + 1 >= maxRecords) fail();
      const client = new AvailKitClient({ ...config, fetch: transport.fetch, timeoutMs: Math.min(10_000, remaining) });
      requests++; // Actual SDK invocation, including rejected/failed admitted reads.
      try { return await operation(client); } finally { await transport.join(); }
    }
    function page(v: unknown): asserts v is { items: unknown[]; nextAfter: string | null } {
      closed(v, ['items', 'nextAfter']);
      if (!Array.isArray(v.items) || v.items.length > 100) fail();
      const last: unknown = v.items.at(-1);
      if (v.nextAfter !== null && (typeof v.nextAfter !== 'string' || !v.nextAfter || Buffer.byteLength(v.nextAfter) > 4096 || v.items.length !== 100 || !object(last) || v.nextAfter !== last.id)) fail();
    }
    async function pages(type: DataType, get: (c: AvailKitClient, after?: string) => Promise<unknown>, first?: unknown) {
      let after: string | undefined;
      const cursors = new Set<string>();
      for (;;) {
        const value = first ?? await read(c => get(c, after)); first = undefined; page(value);
        let previous = after ?? '';
        for (const item of value.items) {
          if (!object(item)) fail(); id(item.id);
          if (item.id <= previous) fail(); previous = item.id;
          await emit(type, item);
        }
        if (value.nextAfter === null) break;
        if (value.nextAfter === after || cursors.has(value.nextAfter)) fail();
        cursors.add(value.nextAfter); after = value.nextAfter;
      }
    }
    // Reserve empty output, then observe MANAGE and READ on separate responses
    // before writing data. These are not an atomic/continuously combined grant
    // or a way to recall received data; later reads have their own authorization.
    let webhooks: unknown = await read(c => c.listWebhooks({ limit: 100 })); page(webhooks);
    const usage = await read(c => c.getUsage());
    await write('header', { schemaVersion: 2, configuredWorkspaceId: config.workspaceId, scope: 'credential-selected', consistency: 'per-response' });
    await emit('usage', usage);
    const webhookTraversal = pages('webhook', (c, after) => c.listWebhooks({ after, limit: 100 }), webhooks);
    webhooks = undefined; await webhookTraversal;
    for (const subscriptionId of ids.webhook) await pages('delivery', (c, after) => c.listWebhookDeliveries(subscriptionId, { after, limit: 100 }));
    await pages('resource', (c, after) => c.listResources({ after, limit: 100 }));
    for (const resourceId of ids.resource) await emit('hours', await read(c => c.getHours(resourceId)), resourceId);
    await pages('offering', (c, after) => c.listOfferings({ after, limit: 100 }));
    await pages('booking', (c, after) => c.listBookings({ after, limit: 100 }));
    let after = 0; let firstEventPage = true;
    for (;;) {
      const value = await read(c => c.events({ after, limit: 100 })); closed(value, ['events', 'nextAfter', 'retentionFloor', 'highWater']);
      if (firstEventPage) { await write('event-retention', { retentionFloor: value.retentionFloor, highWater: value.highWater }); after = Math.max(after, value.retentionFloor); firstEventPage = false; }
      if (!Array.isArray(value.events) || value.events.length > 100 || !integer(value.nextAfter, after)) fail();
      for (const event of value.events) {
        if (!object(event) || !integer(event.sequence, after + 1)) fail();
        await emit('event', event); after = event.sequence;
      }
      if (value.nextAfter !== after) fail();
      if (value.events.length < 100) break;
    }
    await write('end', { traversalComplete: true, recordCount: records, requestCount: requests, bytesBeforeEnd: bytes, counts });
    await file.sync(); closeAttempted = true; await file.close();
    const summary: ExportSummary = { status: 'complete', records, requests, bytes };
    checkSecret(JSON.stringify(summary));
    return summary;
  } catch { throw new ExportError(); }
  finally {
    await transport.join();
    if (file && !closeAttempted) { try { await file.close(); } catch { /* Failure remains failure; never retry an ambiguous close. */ } }
  }
}
