import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runCli } from '../src/cli.mts';
import { commandDiscovery } from '../src/cli-discovery.mts';
import { diagnoseSetup } from '../src/cli-diagnostics.mts';
const env = { AVAILKIT_BASE_URL: 'https://api.example.invalid', AVAILKIT_WORKSPACE_ID: 'a'.repeat(32), AVAILKIT_CREDENTIAL: 'private-synthetic-credential' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
async function invoke(args: string[], config: NodeJS.ProcessEnv = env) {
  let output = '', failed = false;
  try { await runCli(args, config, value => { output += value; }); } catch { failed = true; }
  return { failed, output, result: JSON.parse(output) };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'availkit-agent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('help and complete workspace discovery run offline even with inaccessible credential configuration', async t => {
  const before = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('must stay offline'); };
  t.after(() => { globalThis.fetch = before; });
  let help = '';
  await runCli(['help'], { AVAILKIT_CREDENTIAL_FILE: '/private/path/must-not-open' }, text => { help += text; });
  assert.match(help, /Usage: availkit \[--json\]/);
  const discovered = await invoke(['discover'], { AVAILKIT_CREDENTIAL_FILE: '/private/path/must-not-open' });
  assert.equal(discovered.failed, false);
  const names = discovered.result.operations.map((op: { command: string[] }) => op.command.join(' '));
  assert.deepEqual(new Set(names), new Set([
    'help', 'discover', 'doctor', 'auth check', 'hours get', 'hours replace', 'booking list', 'booking get',
    'availability', 'book', 'reschedule', 'cancel', 'events', 'usage', 'replays-prune', 'history-prune',
    'customers-erase', 'customers-export', 'export', 'business-export', 'resource-create', 'offering-create', 'hours-replace',
    'webhook create', 'webhook list', 'webhook disable', 'webhook deliveries',
    ...['resource', 'offering', 'customer'].flatMap(kind => ['create', 'list', 'get', 'replace', 'archive'].map(verb => `${kind} ${verb}`)),
  ]));
  assert.ok(!names.some((name: string) => name.includes('recovery')));
  const operation = (name: string) => discovered.result.operations.find((op: { command: string[] }) => op.command.join(' ') === name);
  assert.equal(operation('customer list').permissions.bits, 4);
  assert.equal(operation('resource create').permissions.bits, 8);
  assert.equal(operation('webhook deliveries').permissions.bits, 1);
  assert.equal(operation('customers-erase').permissions.bits, 36);
  assert.equal(operation('history-prune').permissions.bits, 36);
  assert.equal(operation('replays-prune').permissions.bits, 32);
  assert.match(operation('book').permissions.conditional, /total bits=6/);
  assert.equal(operation('book').replay, 'same_intent_key_24h');
  assert.equal(operation('customer create').replay, 'no_replay');
  assert.equal(operation('webhook create').arguments[1].name, 'SECRET_OUTPUT_FILE');
  for (const schema of Object.values(discovered.result.inputSchemas) as Record<string, unknown>[]) assert.equal(schema.additionalProperties, false);
  assert.equal(discovered.result.inputSchemas.hours.properties.windows.items.additionalProperties, false);
  assert.equal(discovered.result.inputSchemas.resource.properties.capacity.maximum, 1000);
  assert.equal(discovered.result.inputSchemas.offering.properties.durationMinutes.maximum, 1440);
  assert.deepEqual(discovered.result.inputSchemas.booking.required, ['offeringId', 'start']);
  const wrapped = await invoke(['--json', 'discover'], {});
  assert.equal(wrapped.result.outcome, 'confirmed_success');
  assert.deepEqual(wrapped.result.data, commandDiscovery);
  assert.equal(requests, 0);
});

test('doctor gives actionable private offline diagnostics for source conflicts, bad URLs, missing and unsafe files', async t => {
  const dir = await fixture(t), secretPath = join(dir, 'sensitive-path'), secret = 'never-print-this-secret';
  await writeFile(secretPath, secret, { mode: 0o600 });
  const before = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('offline'); };
  t.after(() => { globalThis.fetch = before; });
  for (const config of [
    { ...env, AVAILKIT_BASE_URL: `https://${secret}@example.invalid`, AVAILKIT_WORKSPACE_ID: secret },
    { ...env, AVAILKIT_CREDENTIAL_FILE: secretPath },
    { ...env, AVAILKIT_CREDENTIAL: undefined, AVAILKIT_CREDENTIAL_FILE: join(dir, secret) },
  ]) {
    const report = await diagnoseSetup(config);
    assert.equal(report.ok, false);
    assert.equal(report.offline, true);
    assert.ok(report.checks.some(check => check.status === 'error' && check.nextStep.includes('AVAILKIT_')));
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.ok(!JSON.stringify(report).includes(dir));
  }
  const valid = { ...env, AVAILKIT_CREDENTIAL: undefined, AVAILKIT_CREDENTIAL_FILE: secretPath };
  assert.equal((await diagnoseSetup(valid)).ok, true);
  await chmod(secretPath, 0o644);
  assert.equal((await diagnoseSetup(valid)).ok, false);
  const doctor = await invoke(['--json', 'doctor'], valid);
  assert.equal(doctor.failed, true);
  assert.equal(doctor.result.outcome, 'not_sent');
  assert.equal(doctor.result.data.ok, false);
  assert.match(JSON.stringify(doctor.result.data), /authority_not_verified_offline/);
  assert.equal(requests, 0);
});

test('machine mutation outcomes distinguish confirmed response, local failure, known rejection, transport and malformed response uncertainty', async t => {
  const dir = await fixture(t), input = join(dir, 'book.json');
  const offeringId = 'b'.repeat(32), start = '2030-01-07T09:00:00Z';
  await writeFile(input, JSON.stringify({ offeringId, start }));
  const args = ['--json', 'book', input, 'synthetic-intent-001'];
  const booking = { id: 'c'.repeat(32), resourceId: 'd'.repeat(32), offeringId, start, end: '2030-01-07T09:30:00Z', status: 'confirmed' };
  const before = globalThis.fetch; t.after(() => { globalThis.fetch = before; });
  const cases: [() => Promise<Response>, string, boolean][] = [
    [async () => json(booking, 201), 'confirmed_success', false],
    [async () => json({ error: { code: 'scope_denied', message: env.AVAILKIT_CREDENTIAL } }, 403), 'rejected', true],
    [async () => json({ error: { code: 'idempotency_conflict', message: 'conflict' } }, 409), 'rejected', true],
    [async () => { throw new Error(`${input} ${env.AVAILKIT_CREDENTIAL}`); }, 'unknown', true],
    [async () => json({ error: { code: 'unrecognized-server-code', message: env.AVAILKIT_CREDENTIAL } }, 403), 'unknown', true],
    [async () => json({ error: { code: 'invalid_input', message: 'server failed after possible commit' } }, 500), 'unknown', true],
    [async () => json({ unexpected: env.AVAILKIT_CREDENTIAL }, 400), 'unknown', true],
    [async () => json({ bad: 'representation' }, 201), 'unknown', true],
  ];
  for (const [reply, outcome, failed] of cases) {
    let requests = 0; globalThis.fetch = async () => { requests++; return reply(); };
    const value = await invoke(args);
    assert.equal(value.failed, failed); assert.equal(value.result.outcome, outcome); assert.equal(value.result.command, 'book');
    assert.equal(requests, 1, 'no retry or automatic inspection');
    assert.ok(!value.output.includes(input)); assert.ok(!value.output.includes(env.AVAILKIT_CREDENTIAL));
    if (outcome === 'unknown') assert.match(value.result.error.nextStep, /Never automatically retry/);
  }
  let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('unexpected request'); };
  for (const invalid of [['--json', 'book', join(dir, 'missing'), 'synthetic-intent-001'], ['--json', 'cancel', 'c'.repeat(32), 'short'], ['--json', 'resource', 'get', '--json'], ['--json', '--json', 'usage']]) {
    const value = await invoke(invalid);
    assert.equal(value.failed, true); assert.equal(value.result.outcome, 'not_sent');
  }
  assert.equal(requests, 0);
});

test('JSON subprocess failures exit nonzero with one stdout envelope and silent stderr; existing plain output remains compatible', async t => {
  const cli = fileURLToPath(new URL('../src/cli.mts', import.meta.url));
  for (const args of [['--json', 'usage'], ['--json', 'doctor'], ['--json', 'unknown-credential-value']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, AVAILKIT_WORKSPACE_ID: '', AVAILKIT_BASE_URL: '' } });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, ''); assert.equal(result.stdout.trim().split('\n').length, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.outcome, 'not_sent'); assert.equal(output.schemaVersion, 1);
    assert.ok(!result.stdout.includes('unknown-credential-value'));
  }
  const before = globalThis.fetch; t.after(() => { globalThis.fetch = before; });
  const resource = { id: 'b'.repeat(32), name: 'Room', timeZone: 'UTC', capacity: 1, archived: false };
  globalThis.fetch = async () => json(resource);
  let output = '';
  await runCli(['resource', 'get', resource.id], env, text => { output += text; });
  assert.deepEqual(JSON.parse(output), resource);
  assert.equal(Object.hasOwn(JSON.parse(output), 'outcome'), false);
});


test('recognized error codes cannot reflect a credential from either source', async t => {
  const dir = await fixture(t), path = join(dir, 'credential');
  const secret = 'scope_denied';
  await writeFile(path, secret, { mode: 0o600 });
  const before = globalThis.fetch; t.after(() => { globalThis.fetch = before; });
  globalThis.fetch = async () => json({ error: { code: secret, message: secret } }, 403);
  for (const config of [{ ...env, AVAILKIT_CREDENTIAL: secret }, { ...env, AVAILKIT_CREDENTIAL: undefined, AVAILKIT_CREDENTIAL_FILE: path }]) {
    const value = await invoke(['--json', 'cancel', 'b'.repeat(32), 'synthetic-intent-002'], config);
    assert.equal(value.failed, true); assert.equal(value.result.outcome, 'rejected');
    assert.equal(value.result.error.code, 'redacted_error');
    assert.ok(!value.output.includes(secret)); assert.ok(!value.output.includes(path));
  }
});
