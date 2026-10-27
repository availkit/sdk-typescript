import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { AvailKitClient } from './index.ts';
import type { ClientOptions, Fetch } from './index.ts';

export const customerExportFailure = 'Customer export failed. Keep any empty or partial output private; it is incomplete even if an end marker exists. Check configuration, secret MANAGE access, limits and disk. Choose a new private file for a later explicit attempt. No retry, resume or automatic cleanup was performed.\n';
export class CustomerExportError extends Error {
  constructor() { super('Customer export failed'); this.name = 'CustomerExportError'; }
}
function fail(): never { throw new CustomerExportError(); }
const integer = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
export function parseCustomerExportArgs(args: string[]): string {
  if (args.length !== 1 || typeof args[0] !== 'string' || !args[0].trim() || args[0].startsWith('--') || args[0].includes('\0')) fail();
  return args[0];
}

// A deliberately small descriptor interface permits real-file failure injection.
export interface CustomerExportFile {
  stat(): Promise<{ isFile(): boolean }>;
  chmod(mode: number): Promise<void>;
  write(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface CustomerExportDependencies {
  fetch?: Fetch;
  reserve?: (path: string) => Promise<CustomerExportFile>;
  now?: () => number;
  /** Tests can lower bounds only; the CLI never accepts limit overrides. */
  limits?: { records?: number; requests?: number; bytes?: number };
}
export interface CustomerExportSummary { status: 'complete'; records: number; requests: number; bytes: number }

// Track the fetch/read/cancel promises we observe, including late abort responses.
// This joins observed work, not arbitrary socket/library activity. An uncooperative
// transport can delay settlement beyond the read-admission budget.
function joinedTransport(fetch: Fetch) {
  const pending = new Set<Promise<unknown>>();
  function track<T>(p: Promise<T>): Promise<T> {
    pending.add(p);
    void p.then(() => pending.delete(p), () => pending.delete(p));
    return p;
  }
  const wrapped: Fetch = (url, init) => track((async () => {
    const response = await fetch(url, init);
    if (init.signal?.aborted) { if (response.body) await track(response.body.cancel()); fail(); }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let ended = false;
    const release = () => {
      if (!ended) { ended = true; init.signal?.removeEventListener('abort', onAbort); reader.releaseLock(); }
    };
    const cancel = () => { if (!ended) return track(reader.cancel().finally(release)); };
    const onAbort = () => { void cancel()?.catch(() => {}); };
    init.signal?.addEventListener('abort', onAbort, { once: true });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await track(reader.read());
          if (part.done) { release(); controller.close(); } else controller.enqueue(part.value);
        } catch { release(); controller.error(new CustomerExportError()); }
      },
      cancel() { return cancel(); },
    }, { highWaterMark: 0 });
    const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(result, 'redirected', { value: response.redirected });
    return result;
  })());
  return { fetch: wrapped, async join() { while (pending.size) await Promise.allSettled([...pending]); } };
}

/** Explicit private contact output. Uses only the existing authorized GET SDK. */
export async function exportCustomers(outputPath: string, configuration: Pick<Extract<ClientOptions, { credential: string }>, 'baseUrl' | 'workspaceId' | 'credential'>, deps: CustomerExportDependencies = {}): Promise<CustomerExportSummary> {
  let file: CustomerExportFile | undefined, closeAttempted = false;
  const transport = joinedTransport(deps.fetch ?? globalThis.fetch);
  try {
    parseCustomerExportArgs([outputPath]);
    const { baseUrl, workspaceId, credential } = configuration;
    const config = { baseUrl, workspaceId, credential };
    if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId === '.' || workspaceId === '..' || Buffer.byteLength(workspaceId) > 256) fail();
    new AvailKitClient(config); // Validate locally before reserving the file.
    const checkSecret = (text: string) => {
      if (text.includes(credential) || text.includes(JSON.stringify(credential).slice(1, -1))) fail();
    };
    checkSecret(workspaceId);
    checkSecret(JSON.stringify(workspaceId));
    const maxRecords = deps.limits?.records ?? 1000, maxRequests = deps.limits?.requests ?? 32, maxBytes = deps.limits?.bytes ?? 4 * 1024 * 1024;
    if (!integer(maxRecords, 0, 1000) || !integer(maxRequests, 1, 32) || !integer(maxBytes, 1, 4 * 1024 * 1024)) fail();
    const now = deps.now ?? (() => performance.now());
    let previousTime = now();
    if (!Number.isFinite(previousTime)) fail();
    const deadline = previousTime + 30_000;
    file = await (deps.reserve ?? (path => open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)))(outputPath);
    if (!(await file.stat()).isFile()) fail();
    await file.chmod(0o600);
    const output = file;
    let bytes = 0, records = 0, requests = 0;
    async function write(type: 'header' | 'customer' | 'end', data: object) {
      // Inspect decoded strings too: an already escaped credential in a field
      // becomes double-escaped on serialization and can evade encoded-line checks.
      for (const value of Object.values(data)) if (typeof value === 'string') checkSecret(value);
      const line = JSON.stringify({ type, data }) + '\n';
      checkSecret(line);
      const buffer = Buffer.from(line, 'utf8');
      if (bytes + buffer.length > maxBytes) fail();
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await output.write(buffer, offset, buffer.length - offset, null);
        if (!integer(bytesWritten, 1, buffer.length - offset)) fail();
        offset += bytesWritten;
      }
      bytes += buffer.length;
    }
    let after: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const time = now();
      if (!Number.isFinite(time) || time < previousTime) fail();
      previousTime = time;
      const remaining = Math.floor(deadline - time);
      if (remaining < 1 || requests >= maxRequests) fail();
      const client = new AvailKitClient({ ...config, timeoutMs: Math.min(10_000, remaining), fetch: transport.fetch });
      requests++;
      // SDK enforces closed pages/records, bounded contacts, opaque hex IDs,
      // ascending IDs, full-page cursors and no-store on successful responses.
      const page = await (async () => {
        try { return await client.listCustomers({ after, limit: 100 }); }
        finally { await transport.join(); }
      })();
      if (requests === 1) await write('header', { schemaVersion: 1, configuredWorkspaceId: workspaceId, scope: 'credential-selected', consistency: 'per-response' });
      for (const customer of page.items) {
        if (records >= maxRecords || seen.has(customer.id) || customer.id <= (after ?? '')) fail();
        seen.add(customer.id);
        // Never serialize the returned object, even after SDK validation.
        await write('customer', { id: customer.id, displayName: customer.displayName, email: customer.email, phone: customer.phone, archived: customer.archived });
        records++;
      }
      if (page.nextAfter === null) break;
      if (page.nextAfter === after || !seen.has(page.nextAfter)) fail();
      after = page.nextAfter;
    }
    await write('end', { traversalComplete: true, recordCount: records, requestCount: requests, bytesBeforeEnd: bytes });
    const summary: CustomerExportSummary = { status: 'complete', records, requests, bytes };
    checkSecret(JSON.stringify(summary));
    await file.sync();
    closeAttempted = true;
    await file.close();
    return summary;
  } catch { throw new CustomerExportError(); }
  finally {
    await transport.join();
    if (file && !closeAttempted) {
      closeAttempted = true;
      try { await file.close(); } catch { /* Preserve failure; never retry an ambiguous close. */ }
    }
  }
}
