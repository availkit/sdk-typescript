import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { AvailKitClient, AvailKitError } from '../src/index.ts';
import type { Fetch, ReplayPruneResult } from '../src/index.ts';
import { runCli, help } from '../src/cli.mts';

const credential = 'synthetic-retention-"\\credential';
const escaped = JSON.stringify(credential).slice(1, -1);
const env = { AVAILKIT_BASE_URL: 'http://127.0.0.1/local', AVAILKIT_WORKSPACE_ID: 'ws/one', AVAILKIT_CREDENTIAL: credential };
const url = 'http://127.0.0.1/local/v1/workspaces/ws%2Fone/maintenance/expired-replays';
const fixture = (deleted = 0, hasMore = false): ReplayPruneResult => ({ asOf: '2026-10-19T06:00:00.123Z', deleted, hasMore });
const json = (data: unknown, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const client = (fetch: Fetch, extra = {}) => new AvailKitClient({ baseUrl: env.AVAILKIT_BASE_URL, workspaceId: env.AVAILKIT_WORKSPACE_ID, credential, fetch, ...extra });
const protocol = (e: unknown) => e instanceof AvailKitError && e.kind === 'protocol';
function safe(text: string, secret = credential) {
  assert(!text.includes(secret)); assert(!text.includes(JSON.stringify(secret).slice(1, -1)));
}
function wire(actualUrl: string, init: RequestInit, limit: number, secret = credential) {
  assert.equal(actualUrl, url); assert.equal(init.method, 'POST');
  assert.equal(init.body, JSON.stringify({ limit }));
  assert.deepEqual(Object.fromEntries(new Headers(init.headers)), {
    accept: 'application/json', authorization: `Bearer ${secret}`, 'content-type': 'application/json',
  });
  assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'omit');
  assert(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted, false);
}

test('retention SDK sends exact scoped POST once per explicit batch without key or follow-up', async () => {
  for (const [limit, deleted, hasMore] of [[1, 0, false], [1, 1, true], [128, 128, true], [128, 128, false], [10, 3, false]] as const) {
    let calls = 0;
    const c = client(async (actualUrl, init) => { calls++; wire(actualUrl, init, limit); return json(fixture(deleted, hasMore)); });
    assert.deepEqual(await c.pruneExpiredReplays(limit), fixture(deleted, hasMore));
    assert.equal(calls, 1);
  }
});

test('retention SDK rejects every invalid limit before fetch', async () => {
  let calls = 0; const c = client(async () => { calls++; return json(fixture()); });
  for (const value of [undefined, null, '1', true, {}, [], 0, -1, -0, 129, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(async () => c.pruneExpiredReplays(value as number), e => e instanceof AvailKitError && e.kind === 'input' && e.code === 'invalid_limit');
  }
  assert.equal(calls, 0);
});

test('retention SDK enforces closed fields, integer deletion bound and hasMore relationship', async () => {
  const bad: unknown[] = [null, [], {}, { asOf: fixture().asOf, deleted: 0 }, { deleted: 0, hasMore: false },
    { ...fixture(), keys: [credential] }, { ...fixture(), receipt: { body: credential } },
    ...[-1, 0.5, 11, Number.MAX_SAFE_INTEGER, '1', null, true].map(deleted => ({ ...fixture(), deleted })),
    ...[null, 0, 'false', {}].map(hasMore => ({ ...fixture(), hasMore })), fixture(0, true), fixture(9, true)];
  for (const value of bad) {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return json(value); }).pruneExpiredReplays(10), protocol);
    assert.equal(calls, 1);
  }
});

test('retention SDK requires real UTC calendar instants without normalizing impossible dates', async () => {
  for (const asOf of ['2026-02-30T06:00:00Z', '2027-02-29T06:00:00Z', '2026-10-19T24:00:00Z', '2026-10-19T06:60:00Z', '2026-10-19', '2026-10-19T06:00:00+00:00', '2026-10-19T06:00:00+01:00', '2026-10-19t06:00:00z', '2026-10-19T06:00:00Z\n', credential, null, 0]) {
    await assert.rejects(client(async () => json({ ...fixture(), asOf })).pruneExpiredReplays(1), protocol);
  }
  for (const asOf of ['2024-02-29T23:59:59Z', '2026-10-19T06:00:00.123456Z', '0000-01-01T00:00:00Z']) {
    const value = { ...fixture(), asOf };
    assert.deepEqual(await client(async () => json(value)).pruneExpiredReplays(1), value);
  }
});

test('retention SDK keeps refusal status, permits safe codes and discards error reflections and causes', async () => {
  for (const [status, code] of [[400, 'invalid_input'], [401, 'unauthorized'], [403, 'scope_denied'], [403, 'forbidden'], [503, 'unavailable']] as const) {
    for (const returnedCode of [code, credential, escaped, 'private-server-detail']) {
      let calls = 0;
      await assert.rejects(client(async () => { calls++; return json({ error: { code: returnedCode, message: credential, cause: credential }, body: credential }, status); }).pruneExpiredReplays(1), e => {
        assert(e instanceof AvailKitError); assert.equal(e.kind, 'api'); assert.equal(e.status, status);
        assert.equal(e.code, returnedCode === code ? code : 'api_error'); assert.equal(e.cause, undefined);
        safe(String(e)); safe(JSON.stringify(e)); return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test('retention SDK refuses bad status, cache, content, redirects, UTF8 and byte overflow without resend', async () => {
  const redirected = json(fixture()); Object.defineProperty(redirected, 'redirected', { value: true });
  const uncached = json(fixture()); uncached.headers.delete('cache-control');
  const responses = [json(fixture(), 201), json(fixture(), 200, { 'Cache-Control': 'public' }), uncached,
    json(fixture(), 200, { 'Content-Type': 'text/plain' }), redirected,
    new Response('{', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }),
    json({ error: { code: credential } }, 403)];
  for (const response of responses) {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return response; }).pruneExpiredReplays(1), protocol);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(client(async () => { calls++; return json(fixture()); }, { maxResponseBytes: 20 }).pruneExpiredReplays(1), e => protocol(e) && (e as AvailKitError).code === 'response_too_large');
  assert.equal(calls, 1);
});

test('retention SDK fetch and body timeouts abort the injected operation without retries', async () => {
  for (const bodyWait of [false, true]) {
    let calls = 0, cancelled = false; let signal: AbortSignal | undefined;
    const c = client(async (_, init) => {
      calls++; signal = init.signal as AbortSignal;
      if (!bodyWait) return new Promise<Response>(resolve => signal!.addEventListener('abort', () => resolve(json(fixture())), { once: true }));
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }, { timeoutMs: 10 });
    await assert.rejects(c.pruneExpiredReplays(1), e => e instanceof AvailKitError && e.kind === 'transport' && e.code === 'timeout');
    await new Promise(resolve => setImmediate(resolve));
    assert(signal!.aborted); assert.equal(calls, 1); if (bodyWait) assert(cancelled);
  }
});

test('retention SDK loss leaves unknown outcome; a manual call sends a new independent batch', async () => {
  let calls = 0;
  const c = client(async (actualUrl, init) => {
    calls++; wire(actualUrl, init, calls === 1 ? 1 : 2);
    if (calls === 1) throw new Error(credential, { cause: escaped });
    return json(fixture(2, true));
  });
  await assert.rejects(c.pruneExpiredReplays(1), e => {
    assert(e instanceof AvailKitError); assert.equal(e.kind, 'transport'); assert.equal(e.cause, undefined);
    safe(String(e)); safe(JSON.stringify(e)); return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(await c.pruneExpiredReplays(2), fixture(2, true)); assert.equal(calls, 2);
});

test('retention CLI runCli validates exact decimal arguments and configuration before send', async () => {
  const previous = globalThis.fetch;
  try {
    let calls = 0, output = '';
    globalThis.fetch = async (actualUrl, init) => { calls++; wire(String(actualUrl), init!, 128); return json(fixture(128, true)); };
    await runCli(['replays-prune', '128'], env, text => { output += text; });
    assert.deepEqual(JSON.parse(output), fixture(128, true)); safe(output);
    for (const args of [[], ['1', credential], ...['0', '-1', '129', '1.0', '1e2', '+1', '01', ' 1', '1 ', '0x10', 'Infinity', '', '１', '1\n'].map(v => [v])]) {
      await assert.rejects(runCli(['replays-prune', ...args], env, () => { assert.fail('unexpected output'); }), e => e instanceof AvailKitError && e.kind === 'input');
    }
    for (const name of Object.keys(env)) {
      const missing = { ...env }; delete (missing as Record<string, string>)[name];
      await assert.rejects(runCli(['replays-prune', '1'], missing, () => {}), AvailKitError);
    }
    for (const settings of [{ ...env, AVAILKIT_BASE_URL: 'bad' }, { ...env, AVAILKIT_WORKSPACE_ID: '..' }, { ...env, AVAILKIT_CREDENTIAL: 'bad credential' }]) {
      await assert.rejects(runCli(['replays-prune', '1'], settings, () => {}), AvailKitError);
    }
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test('retention CLI help explains explicit batches, access, unknown outcome and logical deletion limits', async () => {
  assert.match(help, /replays-prune LIMIT/); assert.match(help, /secret PRIVACY access and LIMIT 1\.\.128/);
  assert.match(help, /no key, automatic retry or follow-up read/); assert.match(help, /lost response may have committed/);
  assert.match(help, /subject, physical, WAL or backup erasure/); assert.match(help, /bookings and events remain retained/);
  let output = ''; await runCli(['--help'], {}, text => { output += text; }); assert.equal(output, help + '\n');
});

test('retention actual CLI entrypoint joins finite injected children with fixed refusal or unknown guidance', async t => {
  const cli = new URL('../src/cli.mts', import.meta.url);
  const cases = [
    { name: 'ok', status: 200, value: fixture(1, true), exit: 0 },
    ...[400, 401, 403, 503].map(status => ({ name: `api-${status}`, status, value: { error: { code: credential, message: escaped }, cause: credential }, exit: 1 })),
    { name: 'loss', status: 0, value: null, exit: 1 },
    { name: 'json', status: 200, value: '{', raw: true, exit: 1 },
    { name: 'private', status: 200, value: { ...fixture(), receipt: credential }, exit: 1 },
    { name: 'date', status: 200, value: { ...fixture(), asOf: credential }, exit: 1 },
    { name: 'relation', status: 200, value: fixture(0, true), exit: 1 },
    { name: 'cache', status: 200, value: fixture(), cache: 'public', exit: 1 },
    { name: 'input', status: 200, value: fixture(), args: ['01'], calls: 0, exit: 1 },
    { name: 'extra', status: 200, value: fixture(), args: ['1', credential], calls: 0, exit: 1 },
    { name: 'config', status: 200, value: fixture(), missing: true, calls: 0, exit: 1 },
    // Fixed guidance and even safe data must be suppressed if they coincide with a credential.
    { name: 'guidance-collision', status: 403, value: { error: { code: 'forbidden', message: 'PRIVACY' } }, secret: 'PRIVACY', exit: 1 },
    { name: 'output-collision', status: 200, value: fixture(), secret: '2026', exit: 1 },
  ];
  const joins: unknown[] = [];
  for (const item of cases) {
    const secret = item.secret ?? credential;
    const childEnv: Record<string, string> = { PATH: process.env.PATH!, ...env, AVAILKIT_CREDENTIAL: secret };
    if (item.missing) delete childEnv.AVAILKIT_CREDENTIAL;
    const script = `
      const assert=(await import('node:assert/strict')).default;
      let calls=0,broken=false;
      globalThis.fetch=async(actualUrl,init)=>{
        calls++;
        try { assert.equal(calls,1); (${wire.toString()})(actualUrl,init,1,${JSON.stringify(secret)}); }
        catch(e) { broken=true; throw e; }
        ${item.status === 0 ? `throw new Error(${JSON.stringify(credential)});` : `return new Response(${JSON.stringify(item.raw ? item.value : JSON.stringify(item.value))},{status:${item.status},headers:{'Content-Type':'application/json','Cache-Control':${JSON.stringify(item.cache ?? 'no-store')}}});`}
      };
      const url=${JSON.stringify(url)};
      process.argv=[process.execPath,${JSON.stringify(cli.pathname)},'replays-prune',...${JSON.stringify(item.args ?? ['1'])}];
      await import(${JSON.stringify(cli.href)});
      process.on('beforeExit',()=>{if(broken||calls!==${item.calls ?? 1})process.exitCode=99;});
    `;
    const start = performance.now();
    const child = spawn(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', script], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10_000);
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
    let exit: number | null, signal: NodeJS.Signals | null;
    try { [exit, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => { child.once('error', reject); child.once('close', (code, reason) => resolve([code, reason])); }); }
    finally { clearTimeout(timer); }
    joins.push({ name: item.name, pid: child.pid, exit, signal, elapsedMs: performance.now() - start, joined: true });
    assert.equal(timedOut, false); assert.equal(signal, null); assert.equal(exit, item.exit, item.name);
    safe(out + err, secret); safe(out + err);
    if (item.exit === 0) { assert.deepEqual(JSON.parse(out), item.value); assert.equal(err, ''); }
    else {
      assert.equal(out, '');
      if (item.name === 'guidance-collision') assert.equal(err, '');
      else {
        assert.match(err, /No automatic retry was sent/);
        if (item.calls === 0 || [400, 401, 403].includes(item.status)) assert.match(err, /Check LIMIT .*configuration and secret PRIVACY access/);
        else { assert.match(err, /outcome is unknown and may have committed/); assert.match(err, /new explicit call is another batch/); }
      }
      assert(!err.includes('HTTP')); assert(!err.includes('cause')); assert(!err.includes('receipt'));
    }
  }
  t.diagnostic(JSON.stringify({ version: process.version, cliChildren: joins }));
});
