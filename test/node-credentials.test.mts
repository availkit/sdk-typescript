import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeClient, type NodeClientOptions } from '../src/node.ts';
import { AvailKitClient, AvailKitError } from '../src/index.ts';
import { resolveNodeCredential } from '../src/node-credential.ts';

const credential = 'synthetic-node-credential-only';
const options = { baseUrl: 'https://api.example.invalid', workspaceId: 'explicit/workspace' };
const page = { events: [], nextAfter: 0, retentionFloor: 0, highWater: 0 };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'availkit-node-credentials-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function safeFailure(code: string, privatePath = '') {
  return (error: unknown) => {
    assert(error instanceof AvailKitError);
    assert.equal(error.kind, 'input');
    assert.equal(error.code, code);
    assert.equal(error.outcome, 'not_sent');
    assert.equal(error.cause, undefined);
    const diagnostic = `${String(error)} ${error.stack} ${JSON.stringify(error)}`;
    assert(!diagnostic.includes(credential));
    if (privatePath) assert(!diagnostic.includes(privatePath));
    return true;
  };
}

test('Node factory loads a private credential once, preserving explicit workspace and transport options', async () => {
  await fixture(async directory => {
    const path = join(directory, 'private-key');
    for (const ending of ['', '\n', '\r\n']) {
      await writeFile(path, credential + ending, { mode: 0o600 });
      let calls = 0;
      const client = await createNodeClient({ ...options, credentialFile: path, timeoutMs: 1000, maxResponseBytes: 1024,
        fetch: async (url, init) => {
          calls++;
          assert.equal(url, `${options.baseUrl}/v1/workspaces/explicit%2Fworkspace/events`);
          assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${credential}`);
          assert.equal(init.credentials, 'omit');
          assert.equal(init.redirect, 'error');
          return json(page);
        },
      });
      assert(client instanceof AvailKitClient);
      assert.equal(calls, 0);
      // Configuration creates no network request. Later calls use the loaded
      // credential even if its file has been replaced, rather than rereading it.
      await writeFile(path, 'replacement-private-key');
      assert.deepEqual(await client.events(), page);
      assert.equal(calls, 1);
      assert.equal(client.credentialFingerprint, createHash('sha256').update(credential).digest('hex'));
      assert.equal(Reflect.set(client, 'credentialFingerprint', 'changed'), false);
      assert(!JSON.stringify(client).includes(credential));
      assert(!JSON.stringify(client).includes(path));
    }
  });
});

test('direct credentials remain supported without reading environment configuration', async () => {
  const client = await createNodeClient({ ...options, credential, fetch: async () => json(page) });
  assert.deepEqual(await client.events(), page);
  assert.equal(client.credentialFingerprint, createHash('sha256').update(credential).digest('hex'));
  assert.equal(await resolveNodeCredential({ credential }), credential);
});

test('missing, conflicting and invalid sources are rejected before any send', async () => {
  let calls = 0;
  const common = { ...options, fetch: async () => { calls++; return json(page); } };
  for (const source of [
    { credential, credentialFile: '/private/path/must-not-open' },
    { credential: '', credentialFile: '' },
  ]) {
    await assert.rejects(createNodeClient({ ...common, ...source } as unknown as NodeClientOptions), safeFailure('ambiguous_credential'));
  }
  for (const source of [{}, { credential: '' }, { credential: credential + '\n' }, { credential: 24 }]) {
    await assert.rejects(createNodeClient({ ...common, ...source } as NodeClientOptions), safeFailure('invalid_credential'));
  }
  await assert.rejects(createNodeClient({ ...common, credential, browserSession: {} } as unknown as NodeClientOptions), safeFailure('ambiguous_credential'));
  for (const source of [{ credentialFile: '' }, { credentialFile: null }, { credentialFile: 24 }]) {
    await assert.rejects(createNodeClient({ ...common, ...source } as unknown as NodeClientOptions), safeFailure('invalid_credential_file'));
  }
  assert.equal(calls, 0);
});

test('file contents must be bounded UTF-8 containing exactly one credential', async () => {
  await fixture(async directory => {
    const path = join(directory, 'private-content');
    for (const bytes of ['', '\n', ' ', credential + '\n\n', credential + '\r', credential + '\t', credential + '\0', credential + '\u007f', credential + '\u00a0', 'x'.repeat(4097), Buffer.from([0xc3, 0x28])]) {
      await writeFile(path, bytes, { mode: 0o600 });
      await assert.rejects(createNodeClient({ ...options, credentialFile: path }), safeFailure('invalid_credential_file', path));
    }
    await writeFile(path, 'x'.repeat(4096));
    assert.equal((await resolveNodeCredential({ credentialFile: path })).length, 4096);
  });
});

test('unsafe permissions, missing files, directories, final symlinks and FIFOs fail privately', { timeout: 3000 }, async () => {
  await fixture(async directory => {
    const path = join(directory, credential);
    await writeFile(path, credential, { mode: 0o600 });
    for (const mode of [0o640, 0o604, 0o666]) {
      await chmod(path, mode);
      await assert.rejects(createNodeClient({ ...options, credentialFile: path }), safeFailure('invalid_credential_file', path));
    }
    await chmod(path, 0o600);
    const link = join(directory, 'key-link');
    await symlink(path, link);
    const folder = join(directory, 'key-folder');
    await mkdir(folder, { mode: 0o700 });
    const fifo = join(directory, 'key-fifo');
    execFileSync('mkfifo', ['-m', '600', fifo]);
    for (const invalid of [join(directory, 'absent-key'), link, folder, fifo]) {
      await assert.rejects(createNodeClient({ ...options, credentialFile: invalid }), safeFailure('invalid_credential_file', invalid));
    }
    assert.equal(await readFile(path, 'utf8'), credential);
  });
});

test('Node factory preserves send-once unknown mutation outcomes and safe transport errors', async () => {
  let sends = 0;
  const client = await createNodeClient({ ...options, credential,
    fetch: async () => { sends++; throw new Error(credential); },
  });
  await assert.rejects(client.book({ offeringId: 'offering', start: '2030-01-07T09:00:00Z' }, 'synthetic-node-intent-key'), error => {
    assert(error instanceof AvailKitError);
    assert.equal(error.kind, 'transport');
    assert.equal(error.outcome, 'unknown');
    assert(!String(error).includes(credential));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(sends, 1);
});

test('browser entry graphs stay independent of Node modules and the Node-only entry', async () => {
  const visited = new Set<string>();
  async function visit(url: URL) {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    const source = await readFile(url, 'utf8');
    const imports = [...source.matchAll(/(?:\b(?:import|export)\s[^;]*?\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);
    for (const specifier of imports) {
      assert(!specifier.startsWith('node:'), `${url.pathname} imports ${specifier}`);
      assert(!/node(?:-credential)?\.(?:ts|js)$/.test(specifier));
      if (specifier.startsWith('.')) await visit(new URL(specifier, url));
    }
  }
  for (const entry of ['index.ts', 'human.ts', 'public.ts', 'business-export.ts']) await visit(new URL(`../src/${entry}`, import.meta.url));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.exports['./node'], { types: './dist/node.d.ts', import: './dist/node.js' });
});
