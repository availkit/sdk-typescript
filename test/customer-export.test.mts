import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, readFile, stat, writeFile, symlink, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { exportCustomers, CustomerExportError, customerExportFailure, parseCustomerExportArgs } from '../src/customer-export.mts';
import type { CustomerExportDependencies, CustomerExportFile } from '../src/customer-export.mts';
import type { Customer, Fetch } from '../src/index.ts';
import { runCli, help } from '../src/cli.mts';

const credential = 'synthetic-m21-private-credential';
const config = { baseUrl: 'http://127.0.0.1', workspaceId: 'workspace-one', credential };
const env = { AVAILKIT_BASE_URL: config.baseUrl, AVAILKIT_WORKSPACE_ID: config.workspaceId, AVAILKIT_CREDENTIAL: credential };
const hex = (n: number) => n.toString(16).padStart(32, '0');
const customer = (n: number): Customer => ({ id: hex(n), displayName: 'Synthetic contact é', email: n % 2 ? 'synthetic@example.invalid' : null, phone: n % 2 ? null : '+1 555 0100', archived: n % 2 === 0 });
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const safeError = (e: unknown) => e instanceof CustomerExportError && e.cause === undefined && String(e) === 'CustomerExportError: Customer export failed' && Object.keys(e).every(k => k === 'name');
async function root() { return mkdtemp(join(process.env.M21_TEST_ROOT ?? tmpdir(), 'customer-export-')); }
async function destination() { return join(await root(), 'contacts.jsonl'); }
async function lines(path: string) { return (await readFile(path, 'utf8')).trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
function mock(rows: Customer[] = [customer(1)], change?: (value: unknown, call: number) => unknown) {
  let active = 0, maximum = 0;
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    active++; maximum = Math.max(maximum, active);
    try {
      assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
      assert.equal(init.headers.Authorization, `Bearer ${credential}`);
      assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
      const u = new URL(url); calls.push(u.href);
      assert.equal(u.pathname, '/v1/workspaces/workspace-one/customers');
      assert.equal(u.searchParams.get('limit'), '100');
      const items = rows.filter(x => x.id > (u.searchParams.get('after') ?? '')).slice(0, 100);
      const value = { items, nextAfter: items.length === 100 ? items.at(-1)!.id : null };
      await Promise.resolve();
      return json(change ? change(value, calls.length) : value);
    } finally { active--; }
  };
  return { fetch, calls, get maximum() { return maximum; }, get active() { return active; } };
}
const reserve = (path: string) => open(path, 'wx', 0o600);

test('closed multipage active/archived contacts, nullable fields, UTF8 and exact file/end/success counts', async () => {
  const path = await destination(), rows = Array.from({ length: 101 }, (_, i) => customer(i + 1));
  const m = mock(rows);
  const result = await exportCustomers(path, config, { fetch: m.fetch });
  const records = await lines(path);
  assert.deepEqual(records[0], { type: 'header', data: { schemaVersion: 1, configuredWorkspaceId: config.workspaceId, scope: 'credential-selected', consistency: 'per-response' } });
  assert.deepEqual(records.slice(1, -1), rows.map(data => ({ type: 'customer', data })));
  const bytesBeforeEnd = Buffer.byteLength((await readFile(path, 'utf8')).split('\n').slice(0, -2).join('\n') + '\n');
  assert.deepEqual(records.at(-1), { type: 'end', data: { traversalComplete: true, recordCount: 101, requestCount: 2, bytesBeforeEnd } });
  assert.deepEqual(result, { status: 'complete', records: 101, requests: 2, bytes: (await stat(path)).size });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(m.maximum, 1); assert.equal(m.active, 0);
  assert(m.calls[1].includes(`after=${hex(100)}`));
});

test('empty and exactly-full final pages finish honestly; fixed 1000 ceiling includes terminal read', async () => {
  for (const count of [0, 100, 1000, 1001]) {
    const path = await destination(), m = mock(Array.from({ length: count }, (_, i) => customer(i + 1)));
    if (count === 1001) {
      await assert.rejects(exportCustomers(path, config, { fetch: m.fetch }), safeError);
      const rows = await lines(path); assert.equal(rows.filter(x => x.type === 'customer').length, 1000); assert(!rows.some(x => x.type === 'end'));
    } else {
      const r = await exportCustomers(path, config, { fetch: m.fetch });
      assert.equal(r.records, count); assert.equal(r.requests, Math.floor(count / 100) + 1);
    }
    assert.equal(m.calls.length, count >= 1000 ? 11 : Math.floor(count / 100) + 1);
  }
});

test('exclusive regular0600 file exists empty before HTTP; existing file, symlinks and directory preserve paths/modes', async () => {
  const dir = await root(), existing = join(dir, 'existing'), link = join(dir, 'link'), dangling = join(dir, 'dangling'), directory = join(dir, 'directory');
  await writeFile(existing, 'preserve', { mode: 0o640 }); await symlink(existing, link); await symlink(join(dir, 'missing'), dangling); await mkdir(directory, { mode: 0o750 });
  const parentMode = (await stat(dir)).mode, existingMode = (await stat(existing)).mode, directoryMode = (await stat(directory)).mode;
  for (const path of [existing, link, dangling, directory]) {
    const m = mock(); await assert.rejects(exportCustomers(path, config, { fetch: m.fetch }), safeError); assert.equal(m.calls.length, 0);
  }
  assert.equal(await readFile(existing, 'utf8'), 'preserve'); assert.equal((await stat(existing)).mode, existingMode);
  assert.equal((await stat(directory)).mode, directoryMode);
  const path = join(dir, 'new'), m = mock();
  await exportCustomers(path, config, { fetch: async (url, init) => {
    const s = await stat(path); assert(s.isFile()); assert.equal(s.mode & 0o777, 0o600); assert.equal(s.size, 0); return m.fetch(url, init);
  } });
  assert.equal((await stat(dir)).mode, parentMode);
});

test('local arguments/configuration and raised test bounds refuse before reservation and HTTP', async () => {
  for (const args of [[], [''], ['  '], ['--help'], ['a\0b'], ['a', 'extra'], ['a', '--max-calls', '2']]) assert.throws(() => parseCustomerExportArgs(args), safeError);
  assert.equal(parseCustomerExportArgs(['./private.jsonl']), './private.jsonl');
  for (const change of [{ credential: '' }, { credential: 'bad credential' }, { baseUrl: 'file:///secret' }, { baseUrl: 'http://user:password@127.0.0.1' }, { workspaceId: '' }, { workspaceId: '.' }, { workspaceId: '..' }, { workspaceId: 'é'.repeat(129) }, { workspaceId: credential }]) {
    let reserved = 0; const m = mock();
    await assert.rejects(exportCustomers('unused', { ...config, ...change }, { fetch: m.fetch, reserve: async p => { reserved++; return reserve(p); } }), safeError);
    assert.equal(reserved, 0); assert.equal(m.calls.length, 0);
  }
  for (const limits of [{ records: 1001 }, { requests: 33 }, { requests: 0 }, { bytes: 4 * 1024 * 1024 + 1 }, { bytes: 0 }]) {
    let reserved = 0; await assert.rejects(exportCustomers('unused', config, { limits, reserve: async p => { reserved++; return reserve(p); } }), safeError); assert.equal(reserved, 0);
  }
});

test('authority/read/protocol failures remain empty or partial, fixed errors and no subsequent read/retry', async () => {
  for (const status of [400, 401, 403, 503]) {
    const path = await destination(); let calls = 0;
    await assert.rejects(exportCustomers(path, config, { fetch: async () => { calls++; return json({ error: { code: credential, message: credential } }, status); } }), safeError);
    assert.equal(calls, 1); assert.equal((await stat(path)).size, 0);
  }
  const path = await destination(), rows = Array.from({ length: 101 }, (_, i) => customer(i + 1)), m = mock(rows); let calls = 0;
  await assert.rejects(exportCustomers(path, config, { fetch: async (url, init) => { if (++calls === 2) throw new Error(credential); return m.fetch(url, init); } }), safeError);
  assert.equal(calls, 2); const output = await lines(path); assert.equal(output.length, 101); assert(!output.some(x => x.type === 'end'));
});

test('closed bounded customer fields/pages/opaque cursors reject malformed, duplicate and nonadvancing data', async () => {
  const c = customer(1), full = Array.from({ length: 100 }, (_, i) => customer(i + 1));
  const malformed: unknown[] = [
    null, [], {}, { items: [], nextAfter: null, private: credential }, { items: 'x', nextAfter: null }, { items: [], nextAfter: hex(1) },
    { items: [c] }, { items: [c], nextAfter: 'x' }, { items: [c], nextAfter: c.id },
    ...['id', 'displayName', 'email', 'phone', 'archived'].map(key => ({ items: [Object.fromEntries(Object.entries(c).filter(([k]) => k !== key))], nextAfter: null })),
    ...[{ extra: credential }, { id: 'not-opaque' }, { id: 'A'.repeat(32) }, { displayName: '' }, { displayName: 'x'.repeat(161) }, { displayName: 'a\nb' }, { email: 'invalid' }, { email: 'a'.repeat(253) + '@b' }, { phone: '' }, { phone: 'x'.repeat(33) }, { phone: 'a\tb' }, { archived: 1 }].map(change => ({ items: [{ ...c, ...change }], nextAfter: null })),
    { items: [c, c], nextAfter: null }, { items: [customer(2), c], nextAfter: null }, { items: full.concat(customer(101)), nextAfter: null },
    { items: full, nextAfter: hex(99) }, { items: full, nextAfter: 'g'.repeat(4097) },
  ];
  for (const value of malformed) {
    const path = await destination(); let calls = 0;
    await assert.rejects(exportCustomers(path, config, { fetch: async () => { calls++; return json(value); } }), safeError);
    assert.equal(calls, 1); assert.equal((await stat(path)).size, 0);
  }
  const path = await destination(), m = mock(full, value => value);
  await assert.rejects(exportCustomers(path, config, { fetch: async (url, init) => new URL(url).searchParams.has('after') ? json({ items: full, nextAfter: hex(100) }) : m.fetch(url, init) }), safeError);
  assert(!(await lines(path)).some(x => x.type === 'end'));
  for (const response of [() => json({ items: [], nextAfter: null }, 200, { 'Cache-Control': 'public' }), () => new Response('{', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }), () => json({ items: [], nextAfter: null }, 201), () => new Response('private', { headers: { 'Content-Type': 'text/plain' } })]) {
    await assert.rejects(exportCustomers(await destination(), config, { fetch: async () => response() }), safeError);
  }
});

test('literal/JSON-escaped credential collisions never enter contact output or summary', async () => {
  for (const secret of [credential, 'synthetic-"credential\\marker']) {
    for (const name of [secret, JSON.stringify(secret).slice(1, -1)]) {
      const path = await destination();
      await assert.rejects(exportCustomers(path, { ...config, credential: secret }, { fetch: async () => json({ items: [{ ...customer(1), displayName: name }], nextAfter: null }) }), safeError);
      const text = await readFile(path, 'utf8'); assert(!text.includes(secret)); assert(!text.includes(JSON.stringify(secret).slice(1, -1))); assert(!(await lines(path)).some(x => x.type === 'customer'));
    }
    for (const workspaceId of [secret, JSON.stringify(secret).slice(1, -1)]) {
      let reserved = 0;
      await assert.rejects(exportCustomers('unused', { ...config, credential: secret, workspaceId }, { reserve: async p => { reserved++; return reserve(p); } }), safeError);
      assert.equal(reserved, 0);
    }
  }
  // Even fixed metadata/counts can collide with an unusually short credential.
  await assert.rejects(exportCustomers(await destination(), { ...config, credential: 'complete' }, { fetch: async () => json({ items: [], nextAfter: null }) }), safeError);
});

test('record/request/encoded byte bounds fail without completion; exact byte bound succeeds', async () => {
  const path = await destination(), r = await exportCustomers(path, config, { fetch: mock().fetch });
  const exact = await exportCustomers(await destination(), config, { fetch: mock().fetch, limits: { bytes: r.bytes } }); assert.equal(exact.bytes, r.bytes);
  for (const limits of [{ records: 0 }, { bytes: 1 }, { bytes: r.bytes - 1 }, { requests: 1 }]) {
    const path = await destination(), m = mock(limits.requests ? Array.from({ length: 101 }, (_, i) => customer(i + 1)) : undefined);
    await assert.rejects(exportCustomers(path, config, { fetch: m.fetch, limits }), safeError);
    assert(!(await lines(path)).some(x => x.type === 'end')); assert.equal(m.calls.length, 1);
  }
});

test('monotonic30s admission includes reservation and first read; capped remaining timeout aborts/joins late fetch and body', async () => {
  for (const time of [30_000, 30_001, -1, NaN]) {
    let n = 0; const path = await destination(), m = mock();
    await assert.rejects(exportCustomers(path, config, { fetch: m.fetch, now: () => n++ ? time : 0 }), safeError);
    assert.equal(m.calls.length, 0); assert.equal((await stat(path)).size, 0);
  }
  // First page can settle after the budget, but no second read is admitted.
  let tick = 0; const path = await destination(), m = mock(Array.from({ length: 100 }, (_, i) => customer(i + 1)));
  await assert.rejects(exportCustomers(path, config, { fetch: m.fetch, now: () => [0, 0, 30_000][Math.min(tick++, 2)] }), safeError); assert.equal(m.calls.length, 1);
  for (const phase of ['fetch', 'body', 'invalid-header']) {
    let calls = 0, aborted = false, settled = false, cancelled = false, tick = 0, closed = false;
    const path = await destination();
    await assert.rejects(exportCustomers(path, config, {
      now: () => tick++ ? 29_990 : 0,
      reserve: async p => {
        const f = await reserve(p);
        return { stat: () => f.stat(), chmod: n => f.chmod(n), write: (b, o, l, p) => f.write(b, o, l, p), sync: () => f.sync(), close: async () => { assert(settled); assert(cancelled); closed = true; await f.close(); } };
      },
      fetch: async (_url, init) => {
        calls++; init.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
        if (phase === 'fetch') await new Promise(resolve => setTimeout(resolve, 25));
        const body = new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(resolve => setTimeout(() => { settled = true; resolve(); }, 30)),
          async cancel() { await new Promise(resolve => setTimeout(resolve, 15)); cancelled = true; settled = true; },
        }, { highWaterMark: 0 });
        return new Response(body, { headers: { 'Content-Type': phase === 'invalid-header' ? 'text/plain' : 'application/json', 'Cache-Control': 'no-store' } });
      },
    }), safeError);
    assert.equal(calls, 1); assert(aborted); assert(settled); assert(cancelled); assert(closed);
  }
});

test('real descriptor short writes succeed; stat/chmod/write/sync/close failures close once and retain private bytes', async () => {
  for (const mode of ['short', 'nonregular', 'stat', 'chmod', 'zero', 'oversize', 'partial', 'sync', 'close']) {
    const path = await destination(), m = mock(); let writes = 0, closes = 0, syncs = 0;
    const deps: CustomerExportDependencies = { fetch: m.fetch, reserve: async p => {
      const f = await reserve(p);
      const file: CustomerExportFile = {
        stat: async () => { if (mode === 'stat') throw new Error(credential); return mode === 'nonregular' ? { isFile: () => false } : f.stat(); },
        chmod: async n => { if (mode === 'chmod') throw new Error(credential); await f.chmod(n); },
        write: async (b, o, l, p) => {
          writes++;
          if (mode === 'zero') return { bytesWritten: 0 };
          if (mode === 'oversize') return { bytesWritten: l + 1 };
          if (mode === 'partial' && writes > 1) throw new Error(credential);
          return f.write(b, o, ['short', 'partial'].includes(mode) ? Math.min(l, 5) : l, p);
        },
        sync: async () => { syncs++; if (mode === 'sync') throw new Error(credential); await f.sync(); },
        close: async () => { closes++; await f.close(); if (mode === 'close') throw new Error(credential); },
      };
      return file;
    } };
    if (mode === 'short') { const result = await exportCustomers(path, config, deps); assert.equal(result.bytes, (await stat(path)).size); assert(writes > 3); }
    else await assert.rejects(exportCustomers(path, config, deps), safeError);
    assert.equal(closes, 1); assert.equal((await stat(path)).mode & 0o777, 0o600);
    if (['nonregular', 'stat', 'chmod'].includes(mode)) { assert.equal(m.calls.length, 0); assert.equal((await stat(path)).size, 0); }
    if (mode === 'partial') assert.equal((await stat(path)).size, 5);
    if (['sync', 'close'].includes(mode)) { assert.equal(syncs, 1); assert((await lines(path)).some(x => x.type === 'end')); }
  }
});

async function child(args: string[], dir: string, mode = 'success', overrides: NodeJS.ProcessEnv = {}) {
  const loader = join(dir, 'mock-fetch.mjs'), marker = join(dir, 'http-marker');
  await writeFile(loader, `import{appendFile}from'node:fs/promises';globalThis.fetch=async(url,init)=>{await appendFile(${JSON.stringify(marker)},'read\\n',{mode:384});if(init.method!=='GET'||!url.endsWith('/customers?limit=100'))throw Error('unexpected');return new Response(JSON.stringify(${mode === 'refused' ? JSON.stringify({ error: { code: credential, message: credential } }) : JSON.stringify({ items: [customer(1)], nextAfter: null })}),{status:${mode === 'refused' ? 403 : 200},headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})};`, { mode: 0o600 });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(process.execPath, ['--max-old-space-size=96', '--import', loader, 'src/cli.mts', ...args], { cwd: new URL('../', import.meta.url), env: { ...process.env, ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; p.stdout.on('data', x => stdout += x); p.stderr.on('data', x => stderr += x); p.on('error', reject);
    p.on('close', (code, signal) => { try { assert.equal(signal, null); resolve({ code, stdout, stderr }); } catch (error) { reject(error); } });
  });
}

test('actual mock-only CLI children join: private success, fixed refusal, no-HTTP path/config/parse/help and guidance collision', async () => {
  const dir = await root(), path = join(dir, 'contacts.jsonl');
  const r = await child(['customers-export', path], dir); assert.equal(r.code, 0); assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout), { status: 'complete', records: 1, requests: 1, bytes: (await stat(path)).size });
  assert.equal((await readFile(join(dir, 'http-marker'), 'utf8')).trim(), 'read');
  const link = join(dir, 'link'); await symlink(path, link);
  for (const args of [['customers-export', path], ['customers-export', link], ['customers-export', dir], ['customers-export'], ['customers-export', join(dir, 'unused'), 'extra']]) {
    const next = await root(), result = await child(args, next);
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, customerExportFailure);
    await assert.rejects(access(join(next, 'http-marker')));
  }
  const denied = await root(), deniedFile = join(denied, 'denied');
  const failure = await child(['customers-export', deniedFile], denied, 'refused'); assert.equal(failure.code, 1); assert.equal(failure.stdout, ''); assert.equal(failure.stderr, customerExportFailure); assert.equal((await stat(deniedFile)).size, 0);
  const missing = await root(); const configFailure = await child(['customers-export', join(missing, 'unused')], missing, 'success', { AVAILKIT_CREDENTIAL: '' });
  assert.equal(configFailure.code, 1); assert.equal(configFailure.stderr, customerExportFailure); await assert.rejects(access(join(missing, 'http-marker')));
  const suppressed = await child(['customers-export'], await root(), 'success', { AVAILKIT_CREDENTIAL: 'private' }); assert.equal(suppressed.code, 1); assert.equal(suppressed.stderr, ''); assert.equal(suppressed.stdout, '');
  const h = await root(), result = await child(['--help'], h); assert.equal(result.code, 0); assert.equal(result.stdout, help + '\n'); assert.equal(result.stderr, ''); await assert.rejects(access(join(h, 'http-marker')));
  let output = ''; await runCli(['--help'], {}, x => output += x); assert.equal(output, help + '\n');
  assert(help.includes('Export excludes customer contact records')); assert(help.includes('customers-export NEW_PRIVATE_FILE'));
});
