import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { businessExportFailure } from '../src/business-export-file.mts';
import { commandDiscovery } from '../src/cli-discovery.mts';

const credential = 'BusinessExportCLISyntheticPrivateCredential123';
const cli = new URL('../src/cli.mts', import.meta.url).pathname;
const preload = new URL('./business-export-cli-bootstrap.mts', import.meta.url).pathname;
async function fixture(operation: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'availkit-business-export-cli-'));
  try { await operation(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function child(root: string, label: string, args: string[], mode = 'success', secret = credential, keyMode = 0o600) {
  const requests = join(root, label + '-requests.jsonl'), config = join(root, label + '-fixture.json'), key = join(root, label + '-credential.key');
  await writeFile(config, JSON.stringify({ requests, mode, credential: secret }), { mode: 0o600 });
  await writeFile(key, secret + '\n', { mode: keyMode });
  const process = spawn(globalThis.process.execPath, ['--max-old-space-size=96', '--import', preload, cli, ...args], {
    env: { PATH: globalThis.process.env.PATH, AVAILKIT_BUSINESS_EXPORT_TEST_CONFIG: config, AVAILKIT_BASE_URL: 'https://api.example.invalid', AVAILKIT_WORKSPACE_ID: '2'.repeat(32), AVAILKIT_CREDENTIAL_FILE: key }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', error = '', killed = false;
  process.stdout.on('data', bytes => { out += bytes; }); process.stderr.on('data', bytes => { error += bytes; });
  const deadline = setTimeout(() => { killed = true; process.kill(); }, 5000);
  const code = await new Promise<number | null>((resolve, reject) => { process.once('error', reject); process.once('close', resolve); }).finally(() => clearTimeout(deadline));
  assert(!killed, 'owned CLI child exceeded its deadline');
  let calls: { method: string; section: string }[] = [];
  try { calls = (await readFile(requests, 'utf8')).trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  assert(out.length + error.length < 4096); assert(!(out + error).includes(secret));
  for (const privateValue of [root, key, 'cli-export@example.invalid', 'CLI private synthetic contact', 'private-synthetic-target', 'private synthetic body']) assert(!(out + error).includes(privateValue));
  return { code, out, error, calls };
}
test('actual CLI saves all9sections privately and prints only confirmed numeric summary', async () => fixture(async root => {
  const output = join(root, 'complete.jsonl'), result = await child(root, 'complete', ['business-export', output]);
  assert.equal(result.code, 0); assert.equal(result.error, ''); assert.equal(result.calls.length, 9); assert(result.calls.every(call => call.method === 'GET'));
  const summary = JSON.parse(result.out), bytes = await readFile(output, 'utf8');
  assert.deepEqual(summary, { status: 'complete', records: 3, requests: 9, bytes: Buffer.byteLength(bytes) });
  assert.equal((await stat(output)).mode & 0o777, 0o600); assert(bytes.includes('cli-export@example.invalid')); assert(bytes.includes('private-synthetic-target')); assert(!bytes.includes(credential));
  assert.equal(JSON.parse(bytes.trimEnd().split('\n').at(-1)!).type, 'end');
}));
test('actual --json CLI yields one summary envelope and one fixed incomplete-export envelope', async () => fixture(async root => {
  const success = await child(root, 'json-success', ['--json', 'business-export', join(root, 'json.jsonl')]);
  assert.equal(success.code, 0); assert.equal(success.error, ''); const result = JSON.parse(success.out);
  assert.equal(result.schemaVersion, 1); assert.equal(result.command, 'business-export'); assert.equal(result.outcome, 'confirmed_success'); assert.equal(result.data.records, 3);
  const output = join(root, 'json-refused.jsonl'), refused = await child(root, 'json-refused', ['--json', 'business-export', output], 'refuse');
  assert.equal(refused.code, 1); assert.equal(refused.error, ''); assert.equal(refused.calls.length, 1);
  const failure = JSON.parse(refused.out); assert.equal(failure.command, 'business-export'); assert.equal(failure.outcome, 'unknown'); assert.equal(failure.error.kind, 'export'); assert.equal(failure.error.code, 'business_export_failed'); assert.equal(failure.error.nextStep, businessExportFailure.trimEnd());
  assert.equal((await stat(output)).size, 0);
}));
test('actual CLI existing files and symlinks are preserved before any request', async () => fixture(async root => {
  const original = join(root, 'existing'), link = join(root, 'link'); await writeFile(original, 'retained private original', { mode: 0o600 }); await symlink(original, link);
  for (const [label, path] of [['existing', original], ['symlink', link]]) {
    const result = await child(root, label, ['business-export', path]); assert.equal(result.code, 1); assert.equal(result.out, ''); assert.equal(result.error, businessExportFailure); assert.equal(result.calls.length, 0);
  }
  assert.equal(await readFile(original, 'utf8'), 'retained private original');
}));
test('actual CLI call-budget and cancellation failures retain incomplete private output', async () => fixture(async root => {
  const partial = join(root, 'partial.jsonl'), bounded = await child(root, 'bounded', ['business-export', partial, '--max-calls', '1']);
  assert.equal(bounded.code, 1); assert.equal(bounded.out, ''); assert.equal(bounded.error, businessExportFailure); assert.equal(bounded.calls.length, 1);
  assert(!(await readFile(partial, 'utf8')).includes('"type":"end"')); assert.equal((await stat(partial)).mode & 0o777, 0o600);
  const aborted = join(root, 'aborted.jsonl'), result = await child(root, 'abort', ['business-export', aborted, '--work-seconds', '1'], 'abort');
  assert.equal(result.code, 1); assert.equal(result.out, ''); assert.equal(result.error, businessExportFailure); assert.equal(result.calls.length, 1); assert.equal((await stat(aborted)).size, 0);
}));
test('actual CLI invalid arguments and unsafe credential files create no output or request', async () => fixture(async root => {
  for (const [label, flags] of [['missing', []], ['duplicate', ['--max-calls', '1', '--max-calls', '2']], ['bound', ['--work-seconds', '61']], ['unknown', ['--section', 'customers']]] as const) {
    const output = join(root, label + '.jsonl'), result = await child(root, label, ['business-export', ...(label === 'missing' ? [] : [output]), ...flags]);
    assert.equal(result.code, 1); assert.equal(result.out, ''); assert.equal(result.error, businessExportFailure); assert.equal(result.calls.length, 0); await assert.rejects(stat(output));
  }
  const unsafe = join(root, 'unsafe.jsonl'), rejected = await child(root, 'unsafe-key', ['business-export', unsafe], 'success', credential, 0o644);
  assert.equal(rejected.code, 1); assert.equal(rejected.calls.length, 0); assert.equal(rejected.error, businessExportFailure); await assert.rejects(stat(unsafe));
}));
test('resolved credential collisions are suppressed in fixed guidance and JSON metadata', async () => fixture(async root => {
  const plain = await child(root, 'fixed-collision', ['business-export'], 'success', 'READ'); assert.equal(plain.code, 1); assert.equal(plain.out, ''); assert.equal(plain.error, ''); assert.equal(plain.calls.length, 0);
  const machine = await child(root, 'command-collision', ['--json', 'business-export', join(root, 'collision.jsonl')], 'success', 'business-export'); assert.equal(machine.code, 1); assert.equal(machine.out, ''); assert.equal(machine.error, '');
}));
test('discovery declares all9 READ+MANAGE export pages without altering old export entries', () => {
  const operation = commandDiscovery.operations.find(operation => operation.command.join(' ') === 'business-export')!;
  assert.equal(operation.permissions.bits, 5); assert.equal(operation.replay, 'read_only'); assert.equal(operation.automaticRetry, false); assert.deepEqual(operation.api, { method: 'GET', path: '/export' });
  assert.equal(commandDiscovery.operations.find(operation => operation.command.join(' ') === 'export')!.api, undefined);
  assert.equal(commandDiscovery.operations.find(operation => operation.command.join(' ') === 'customers-export')!.permissions.bits, 4);
});
