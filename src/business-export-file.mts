import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ClientOptions, Fetch } from './index.ts';
import type { NodeClientOptions } from './node.ts';
import { resolveNodeCredential } from './node-credential.ts';
import { BusinessExportClient, BusinessExportError, traverseBusinessExport } from './business-export.ts';
import type { BusinessExportOptions, BusinessExportDependencies, BusinessExportSummary } from './business-export.ts';

export const businessExportFailure = 'Business export failed. Keep the private empty or partial file; it is incomplete even if an end marker exists. Check READ and MANAGE access, retained cursors, limits and disk. Start a later explicit export with a new private file. No retry, resume or automatic cleanup was performed.\n';
function fail(): never { throw new BusinessExportError(); }
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
export function parseBusinessExportArgs(args: string[]): { output: string; options: BusinessExportOptions } {
  if (!args[0]?.trim() || args[0].startsWith('--') || args[0].includes('\0')) fail();
  const options: BusinessExportOptions = {}, seen = new Set<string>();
  for (let i = 1; i < args.length; i += 2) {
    const name = args[i], raw = args[i + 1];
    if (!['--max-calls', '--work-seconds'].includes(name) || seen.has(name) || !/^[1-9]\d*$/.test(raw ?? '')) fail();
    seen.add(name); const value = Number(raw);
    if (!integer(value, 1, name === '--max-calls' ? 2048 : 60)) fail();
    if (name === '--max-calls') options.maxCalls = value; else options.workSeconds = value;
  }
  return { output: args[0], options };
}
export interface BusinessExportFile {
  stat(): Promise<{ isFile(): boolean }>;
  chmod(mode: number): Promise<void>;
  write(bytes: Buffer, offset: number, length: number, position: null): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface BusinessExportFileDependencies extends BusinessExportDependencies {
  reserve?: (path: string) => Promise<BusinessExportFile>;
}

// Join the fetch, response-read and cancellation promises this adapter observes.
// This is not a guarantee about arbitrary library/socket work. An uncooperative
// transport can keep the join pending beyond the read-admission work budget.
function joinedTransport(fetch: Fetch) {
  const pending = new Set<Promise<unknown>>();
  function observe<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }
  const send: Fetch = (url, init) => observe((async () => {
    const response = await fetch(url, init);
    if (init.signal?.aborted) { if (response.body) await observe(response.body.cancel()); fail(); }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let released = false;
    function release() { if (!released) { released = true; init.signal?.removeEventListener('abort', abort); reader.releaseLock(); } }
    function cancel() { return released ? Promise.resolve() : observe(reader.cancel().finally(release)); }
    function abort() { void cancel().catch(() => {}); }
    init.signal?.addEventListener('abort', abort, { once: true });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { const next = await observe(reader.read()); if (next.done) { release(); controller.close(); } else controller.enqueue(next.value); }
        catch { release(); controller.error(new BusinessExportError()); }
      },
      cancel() { return cancel(); },
    }, { highWaterMark: 0 });
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(wrapped, 'redirected', { value: response.redirected });
    return wrapped;
  })());
  return { fetch: send, async join() { while (pending.size) await Promise.allSettled([...pending]); } };
}

/** Reserve a new private file before HTTP; never overwrite, resume or upload. */
export async function exportBusinessFile(output: string, config: NodeClientOptions, options: BusinessExportOptions = {}, deps: BusinessExportFileDependencies = {}): Promise<BusinessExportSummary> {
  let file: BusinessExportFile | undefined, closing = false;
  let transport: ReturnType<typeof joinedTransport> | undefined;
  try {
    if (config.browserSession !== undefined) fail();
    const credential = await resolveNodeCredential(config);
    const { credentialFile: _credentialFile, ...base } = config;
    const resolved: ClientOptions = { ...base, credential };
    new BusinessExportClient(resolved);
    if (!output?.trim() || output.includes('\0') || !integer(options.maxCalls ?? 2048, 1, 2048) || !integer(options.workSeconds ?? 30, 1, 60)) fail();
    transport = joinedTransport(config.fetch ?? globalThis.fetch.bind(globalThis));
    file = await (deps.reserve ?? (path => open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)))(output);
    if (!(await file.stat()).isFile()) fail();
    await file.chmod(0o600);
    const reserved = file;
    const result = await traverseBusinessExport({ ...resolved, fetch: transport.fetch }, async line => {
      const bytes = Buffer.from(line);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await reserved.write(bytes, offset, bytes.length - offset, null);
        if (!integer(bytesWritten, 1, bytes.length - offset)) fail();
        offset += bytesWritten;
      }
    }, options, deps);
    await transport?.join();
    await file.sync(); closing = true; await file.close();
    return result;
  } catch { throw new BusinessExportError(); }
  finally {
    await transport?.join();
    if (file && !closing) { try { await file.close(); } catch { /* No ambiguous close retry or cleanup. */ } }
  }
}
