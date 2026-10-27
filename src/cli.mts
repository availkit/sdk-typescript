#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AvailKitClient, AvailKitError } from './index.ts';
import { exportWorkspace, parseExportArgs, exportFailure } from './export.mts';
import { exportCustomers, parseCustomerExportArgs, customerExportFailure } from './customer-export.mts';
import { exportBusinessFile, parseBusinessExportArgs, businessExportFailure } from './business-export-file.mts';
import { resolveNodeCredential } from './node-credential.ts';
import { commandDiscovery, commandName } from './cli-discovery.mts';
import { diagnoseSetup } from './cli-diagnostics.mts';
import type { SetupReport } from './cli-diagnostics.mts';
import { safeErrorCodes } from './errors.ts';
import type { ResourceInput, OfferingInput, Hours, BookingInput, RescheduleInput, WebhookInput, CustomerInput } from './index.ts';

async function configuration(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (env.AVAILKIT_CREDENTIAL_FILE === undefined) return env;
  const credential = await resolveNodeCredential({ credential: env.AVAILKIT_CREDENTIAL || undefined, credentialFile: env.AVAILKIT_CREDENTIAL_FILE });
  return { ...env, AVAILKIT_CREDENTIAL: credential };
}

export const help = `Usage: availkit [--json] COMMAND [arguments]
  discover                Offline JSON command/permission/input schema catalog
  doctor                  Offline private setup checks (nonzero if invalid)
  help                    Offline command help
Place --json first for one structured outcome envelope; failures exit nonzero.
  auth check
  resource create INPUT.json
  resource list [AFTER_ID|-] [LIMIT] [QUERY]
  resource get RESOURCE_ID
  resource replace RESOURCE_ID INPUT.json
  resource archive RESOURCE_ID
  hours get RESOURCE_ID
  hours replace RESOURCE_ID INPUT.json
  offering create INPUT.json
  offering list [AFTER_ID|-] [LIMIT] [QUERY]
  offering get OFFERING_ID
  offering replace OFFERING_ID INPUT.json
  offering archive OFFERING_ID
  booking list [AFTER_ID|-] [LIMIT]
  booking get BOOKING_ID
  history-prune deliveries|events|bookings LIMIT --confirm
  customer create INPUT.json
  customer list [AFTER_ID|-] [LIMIT] [QUERY]
  customer get CUSTOMER_ID
  customer replace CUSTOMER_ID INPUT.json
  customer archive CUSTOMER_ID
  resource-create INPUT.json
  hours-replace RESOURCE_ID INPUT.json
  offering-create INPUT.json
  availability OFFERING_ID FROM_UTC TO_UTC
  book INPUT.json IDEMPOTENCY_KEY
  reschedule BOOKING_ID INPUT.json IDEMPOTENCY_KEY
  cancel BOOKING_ID IDEMPOTENCY_KEY
  events [AFTER_SEQUENCE] [LIMIT]
  usage
  replays-prune LIMIT
  export OUTPUT.jsonl [--max-calls N] [--work-seconds S]
  business-export OUTPUT.jsonl [--max-calls N] [--work-seconds S]
  customers-export NEW_PRIVATE_FILE
  customers-erase CUSTOMER_ID --confirm
  webhook create INPUT.json SECRET_OUTPUT_FILE
  webhook list [AFTER_ID|-] [LIMIT]
  webhook disable SUBSCRIPTION_ID
  webhook deliveries SUBSCRIPTION_ID [AFTER_ID|-] [LIMIT]
Customer commands require secret MANAGE; linked booking requires BOOK+MANAGE.
Customer replace is a full replacement; omitted contacts are cleared. Archive
retains history. Customer writes send once, with no replay key. After an unknown
outcome, inspect current records and deliberately set aside the unresolved request
before another write; reads cannot prove the original result. No automatic retry.
Export excludes customer contact records; linked bookings include only customerId.
Business-export saves all nine retained business/contact/configuration sections
to one new private 0600 JSONL file. Requires secret READ+MANAGE. Webhook URLs and
contacts are private. Independent pages are not a point-in-time snapshot. Keep
empty/partial failures private; no retry, resume, overwrite or automatic cleanup.
Customers-export intentionally saves active and archived contacts to a new private
0600 JSONL file. Requires secret MANAGE. Keep empty/partial failures private;
choose a new file for a later explicit attempt. No retry, resume or automatic cleanup.
Customers-erase requires secret MANAGE+PRIVACY and the literal --confirm flag.
It irreversibly removes the current name/email/phone, retaining the customer ID,
booking links, receipts, events and quota. Existing exports, WAL and backups remain.
It sends once, with no replay key. An unknown outcome may have committed; pause
customer writes and inspect records before deliberately setting the request aside.
Set AVAILKIT_BASE_URL, AVAILKIT_WORKSPACE_ID and either AVAILKIT_CREDENTIAL
or AVAILKIT_CREDENTIAL_FILE (owner-only regular file with a single secret).
GET/list commands return one page; nextAfter is scoped to that collection/environment.
Events expose retentionFloor/highWater; event_cursor_expired requires an explicit
restart from zero rather than silently claiming complete history. History cleanup
reclaims eligible30day terminal deliveries, event prefix, then bookings; quota is
not refunded. Each confirmed invocation is a new bounded batch, never a replay.
Booking/reschedule/cancellation sends once. Only deliberately replay the exact
still-live intent/input/key under current authority within24hours. Expired keys
may begin a new mutation; never automatically resend.
Keep input and key until the outcome is known. No credentials in arguments.
Webhook create reserves a new private file before send, saves/syncs the one-time
response, then prints subscription metadata only. It never automatically retries.
Keep the file private. Pending/sending/unknown status does not mean delivered.
Usage is advisory, not a reservation. Only monthly booking creates reset monthly.
Cancelled bookings, committed events, disabled subscriptions and terminal delivery
rows remain retained. Live replay entries expire individually after 24 hours.
Replay cleanup requires secret PRIVACY access and LIMIT 1..128. Each explicit call
sends one new bounded batch, with no key, automatic retry or follow-up read.
A lost response may have committed. Logical expired-receipt deletion is not
subject, physical, WAL or backup erasure; bookings and events remain retained.`;

class SetupFailure extends Error {
  readonly report: SetupReport;
  constructor(report: SetupReport) { super('AvailKit setup is invalid'); this.report = report; }
}
/** Signals that the single machine-readable failure has already been written. */
class JsonFailure extends Error { constructor() { super('AvailKit command failed'); } }
/** Contains only a safe guidance decision, never the resolved private credential. */
class BusinessExportCliFailure extends Error {
  readonly guidanceAllowed: boolean;
  readonly notSent: boolean;
  constructor(guidanceAllowed: boolean, notSent = false) { super('AvailKit business export incomplete'); this.guidanceAllowed = guidanceAllowed; this.notSent = notSent; }
}
function containsCredential(output: string, credential?: string): boolean {
  return Boolean(credential && (output.includes(credential) || output.includes(JSON.stringify(credential).slice(1, -1))));
}
const localErrorCodes = new Set(['usage', 'invalid_json_flag', 'missing_configuration', 'ambiguous_credential', 'invalid_credential_file', 'invalid_credential', 'invalid_base_url', 'invalid_workspace_id', 'confirmation_required', 'invalid_input_file', 'invalid_customer_file', 'input_too_large', 'invalid_idempotency_key', 'invalid_limits', 'invalid_json', 'body_too_large', 'invalid_customer', 'invalid_reschedule', 'invalid_maintenance', 'invalid_page_budget', 'page_budget_exhausted', 'invalid_response', 'invalid_error', 'response_too_large', 'request_failed', 'timeout', 'unsafe_output', 'secret_output_unavailable', 'webhook_create_rejected', 'webhook_create_unknown', 'webhook_secret_persistence_unknown', 'invalid_webhook']);
function machineFailure(error: unknown, credential?: string) {
  const outcome = error instanceof AvailKitError ? error.outcome : error instanceof SetupFailure ? 'not_sent' : 'unknown';
  const originalCode = error instanceof SetupFailure ? 'invalid_setup' : error instanceof AvailKitError && (safeErrorCodes.has(error.code) || localErrorCodes.has(error.code)) ? error.code : 'command_failed';
  // A recognized server code can itself equal an unusually short credential.
  // Never reflect that value merely because it belongs to the protocol allowlist.
  const code = credential && originalCode.includes(credential) ? 'redacted_error' : originalCode;
  return {
    outcome,
    error: {
      kind: error instanceof AvailKitError ? error.kind : error instanceof SetupFailure ? 'input' : 'unknown', code,
      ...(error instanceof AvailKitError && Number.isInteger(error.status) ? { status: error.status } : {}),
      nextStep: outcome === 'not_sent' ? 'Correct command input/configuration using discover and doctor before an explicit new invocation.'
        : outcome === 'rejected' ? 'Inspect the rejection and current authority/input before deciding on a new invocation. No automatic retry was sent.'
        : 'Outcome is unknown and may have committed. Preserve input and any intent key. Pause writes and inspect current state; reads cannot prove the original outcome. Never automatically retry. Consult discover for the operation replay policy.',
    },
    ...(error instanceof SetupFailure ? { data: error.report } : {}),
  };
}

export async function runCli(args: string[], env: NodeJS.ProcessEnv, write: (text: string) => void): Promise<void> {
  const json = args[0] === '--json';
  const commandArgs = json ? args.slice(1) : args;
  if (!json) {
    if (args.includes('--json')) throw new AvailKitError('input', 'invalid_json_flag');
    return runCliCommand(args, env, write);
  }
  let output = '';
  let credential = env.AVAILKIT_CREDENTIAL;
  try {
    if (commandArgs.includes('--json')) throw new AvailKitError('input', 'invalid_json_flag');
    await runCliCommand(commandArgs, env, text => { output += text; }, value => { credential = value; });
    const data: unknown = commandName(commandArgs) === 'help' ? { help: output.trimEnd() } : JSON.parse(output);
    const result = JSON.stringify({ schemaVersion: 1, command: commandName(commandArgs), outcome: 'confirmed_success', data }) + '\n';
    if (commandName(commandArgs) === 'business-export' && containsCredential(result, credential)) throw new BusinessExportCliFailure(!containsCredential(businessExportFailure, credential));
    write(result);
  } catch (error) {
    const failure = error instanceof BusinessExportCliFailure ? {
      outcome: error.notSent ? 'not_sent' : 'unknown', error: { kind: error.notSent ? 'input' : 'export', code: error.notSent ? 'usage' : 'business_export_failed', nextStep: businessExportFailure.trimEnd() },
    } : machineFailure(error, credential);
    const result = JSON.stringify({ schemaVersion: 1, command: commandName(commandArgs), ...failure }) + '\n';
    if (commandName(commandArgs) !== 'business-export' || !containsCredential(result, credential)) write(result);
    throw new JsonFailure();
  }
}

async function runCliCommand(args: string[], env: NodeJS.ProcessEnv, write: (text: string) => void, observeCredential?: (credential: string | undefined) => void): Promise<void> {
  if (args.length === 1 && ['help', '--help'].includes(args[0])) { write(help + '\n'); return; }
  if (args.length === 1 && args[0] === 'discover') { write(JSON.stringify(commandDiscovery) + '\n'); return; }
  if (args.length === 1 && args[0] === 'doctor') {
    const report = await diagnoseSetup(env);
    write(JSON.stringify(report) + '\n');
    if (!report.ok) throw new SetupFailure(report);
    return;
  }
  env = await configuration(env);
  observeCredential?.(env.AVAILKIT_CREDENTIAL);
  const [command, ...values] = args;
  if (command === 'business-export') {
    const credential = env.AVAILKIT_CREDENTIAL;
    let parsed;
    try { parsed = parseBusinessExportArgs(values); } catch { throw new BusinessExportCliFailure(!containsCredential(businessExportFailure, credential), true); }
    try {
      const result = await exportBusinessFile(parsed.output, { baseUrl: env.AVAILKIT_BASE_URL ?? '', workspaceId: env.AVAILKIT_WORKSPACE_ID ?? '', credential: credential ?? '' }, parsed.options);
      const output = JSON.stringify(result) + '\n';
      if (containsCredential(output, credential)) throw new BusinessExportCliFailure(false);
      write(output); return;
    } catch {
      throw new BusinessExportCliFailure(!containsCredential(businessExportFailure, credential));
    }
  }
  if (command === 'customers-erase') {
    if (values.length !== 2 || values[1] !== '--confirm') throw new AvailKitError('input', 'confirmation_required');
    if (!env.AVAILKIT_BASE_URL || !env.AVAILKIT_WORKSPACE_ID || !env.AVAILKIT_CREDENTIAL) throw new AvailKitError('input', 'missing_configuration');
    const credential = env.AVAILKIT_CREDENTIAL;
    const client = new AvailKitClient({ baseUrl: env.AVAILKIT_BASE_URL, workspaceId: env.AVAILKIT_WORKSPACE_ID, credential });
    const result = await client.eraseCustomer(values[0]);
    const output = JSON.stringify(result) + '\n';
    if (output.includes(credential) || output.includes(JSON.stringify(credential).slice(1, -1))) throw new AvailKitError('protocol', 'unsafe_output');
    write(output); return;
  }
  if (command === 'customers-export') {
    let output: string;
    try { output = parseCustomerExportArgs(values); } catch { throw new AvailKitError('input', 'usage'); }
    const result = await exportCustomers(output, { baseUrl: env.AVAILKIT_BASE_URL ?? '', workspaceId: env.AVAILKIT_WORKSPACE_ID ?? '', credential: env.AVAILKIT_CREDENTIAL ?? '' });
    write(JSON.stringify(result) + '\n'); return;
  }
  if (command === 'export') {
    let options;
    try { options = parseExportArgs(values); } catch { throw new AvailKitError('input', 'usage'); }
    const result = await exportWorkspace(options, { baseUrl: env.AVAILKIT_BASE_URL ?? '', workspaceId: env.AVAILKIT_WORKSPACE_ID ?? '', credential: env.AVAILKIT_CREDENTIAL ?? '' });
    write(JSON.stringify(result) + '\n'); return;
  }
  if (command === 'replays-prune') {
    if (values.length !== 1 || values[0].trim() !== values[0] || !/^[1-9]\d{0,2}$/.test(values[0]) || Number(values[0]) > 128) throw new AvailKitError('input', 'invalid_limit');
    if (!env.AVAILKIT_BASE_URL || !env.AVAILKIT_WORKSPACE_ID || !env.AVAILKIT_CREDENTIAL) throw new AvailKitError('input', 'missing_configuration');
    const client = new AvailKitClient({ baseUrl: env.AVAILKIT_BASE_URL, workspaceId: env.AVAILKIT_WORKSPACE_ID, credential: env.AVAILKIT_CREDENTIAL });
    const result = await client.pruneExpiredReplays(Number(values[0]));
    const output = JSON.stringify(result) + '\n';
    // Even a validated timestamp/count can coincide with an unusually short credential.
    if (output.includes(env.AVAILKIT_CREDENTIAL) || output.includes(JSON.stringify(env.AVAILKIT_CREDENTIAL).slice(1, -1))) throw new AvailKitError('protocol', 'unsafe_output');
    write(output); return;
  }
  const counts: Record<string, number[]> = { resource: [1,2,3,4], offering: [1,2,3,4], hours: [2,3], booking: [1,2,3], 'history-prune': [3], auth: [1], 'resource-create': [1], 'hours-replace': [2], 'offering-create': [1], availability: [3], book: [2], reschedule: [3], cancel: [2], events: [0, 1, 2], usage: [0], customer: [1, 2, 3, 4], webhook: [1, 2, 3, 4] };
  if (!command || !Object.hasOwn(counts, command) || !counts[command].includes(values.length)) throw new AvailKitError('input', 'usage');
  if (command === 'resource' || command === 'offering' || command === 'booking' || command === 'hours') {
    const allowed: Record<string, number[]> = command === 'hours' ? { get: [2], replace: [3] }
      : command === 'booking' ? { get: [2], list: [1,2,3] } : { create: [2], list: [1,2,3,4], get: [2], replace: [3], archive: [2] };
    if (!Object.hasOwn(allowed, values[0]) || !allowed[values[0]].includes(values.length)) throw new AvailKitError('input', 'usage');
  }
  if (command === 'auth' && values[0] !== 'check') throw new AvailKitError('input', 'usage');
  if (command === 'history-prune' && (!['deliveries','events','bookings'].includes(values[0]) || values[2] !== '--confirm' || !/^[1-9]\d{0,2}$/.test(values[1]))) throw new AvailKitError('input', 'confirmation_required');
  if (command === 'customer') {
    const counts: Record<string, number[]> = { create: [2], list: [1, 2, 3, 4], get: [2], replace: [3], archive: [2] };
    if (!Object.hasOwn(counts, values[0]) || !counts[values[0]].includes(values.length)) throw new AvailKitError('input', 'usage');
  }
  if (command === 'webhook') {
    const counts: Record<string, number[]> = { create: [3], list: [1, 2, 3], disable: [2], deliveries: [2, 3, 4] };
    if (!Object.hasOwn(counts, values[0]) || !counts[values[0]].includes(values.length)) throw new AvailKitError('input', 'usage');
  }
  if (!env.AVAILKIT_BASE_URL || !env.AVAILKIT_WORKSPACE_ID || !env.AVAILKIT_CREDENTIAL) throw new AvailKitError('input', 'missing_configuration');
  const credential = env.AVAILKIT_CREDENTIAL;
  const client = new AvailKitClient({ baseUrl: env.AVAILKIT_BASE_URL, workspaceId: env.AVAILKIT_WORKSPACE_ID, credential });
  async function body<T>(path: string): Promise<T> {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); } catch { throw new AvailKitError('input', 'invalid_input_file'); }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536) throw new AvailKitError('input', 'invalid_input_file');
      const bytes = new Uint8Array(65_537);
      let used = 0;
      while (used < bytes.length) {
        const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      if (used > 65_536) throw new AvailKitError('input', 'input_too_large');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))) as T;
    } catch (error) {
      if (error instanceof AvailKitError) throw error;
      throw new AvailKitError('input', 'invalid_input_file');
    } finally { await file.close(); }
  }
  let result: unknown;
  let privateSecret: string | undefined;
  const pageQuery = (after?: string, limit?: string, q?: string) => {
    if (limit !== undefined && !/^[1-9]\d{0,2}$/.test(limit)) throw new AvailKitError('input', 'invalid_limit');
    return { ...(q === undefined ? {} : { q }), after: after === '-' ? undefined : after, limit: limit === undefined ? undefined : Number(limit) };
  };
  switch (command) {
    case 'auth': result = { authenticated: true, usage: await client.getUsage() }; break;
    case 'resource':
      if (values[0] === 'create') result = await client.createResource(await body<ResourceInput>(values[1]));
      if (values[0] === 'list') result = await client.listResources(pageQuery(values[1], values[2], values[3]));
      if (values[0] === 'get') result = await client.getResource(values[1]);
      if (values[0] === 'replace') result = await client.replaceResource(values[1], await body<ResourceInput>(values[2]));
      if (values[0] === 'archive') result = await client.archiveResource(values[1]);
      break;
    case 'hours': result = values[0] === 'get' ? await client.getHours(values[1]) : await client.replaceHours(values[1], await body<Hours>(values[2])); break;
    case 'offering':
      if (values[0] === 'create') result = await client.createOffering(await body<OfferingInput>(values[1]));
      if (values[0] === 'list') result = await client.listOfferings(pageQuery(values[1], values[2], values[3]));
      if (values[0] === 'get') result = await client.getOffering(values[1]);
      if (values[0] === 'replace') result = await client.replaceOffering(values[1], await body<OfferingInput>(values[2]));
      if (values[0] === 'archive') result = await client.archiveOffering(values[1]);
      break;
    case 'booking': result = values[0] === 'get' ? await client.getBooking(values[1]) : await client.listBookings(pageQuery(values[1], values[2])); break;
    case 'history-prune': result = await client.pruneHistory(values[0] as 'deliveries' | 'events' | 'bookings', Number(values[1])); break;
    case 'customer': {
      async function contactBody(path: string): Promise<CustomerInput> {
        try { return await body<CustomerInput>(path); } catch { throw new AvailKitError('input', 'invalid_customer_file'); }
      }
      switch (values[0]) {
        case 'create': result = await client.createCustomer(await contactBody(values[1])); break;
        case 'list': result = await client.listCustomers(pageQuery(values[1], values[2], values[3])); break;
        case 'get': result = await client.getCustomer(values[1]); break;
        case 'replace': result = await client.replaceCustomer(values[1], await contactBody(values[2])); break;
        case 'archive': result = await client.archiveCustomer(values[1]); break;
      }
      break;
    }
    case 'usage': result = await client.getUsage(); break;
    case 'webhook': {
      switch (values[0]) {
        case 'list': result = await client.listWebhooks(pageQuery(values[1], values[2])); break;
        case 'disable': result = await client.disableWebhook(values[1]); break;
        case 'deliveries': result = await client.listWebhookDeliveries(values[1], pageQuery(values[2], values[3])); break;
        case 'create': {
          let data: WebhookInput;
          try { data = await body<WebhookInput>(values[1]); }
          catch { throw new AvailKitError('input', 'invalid_input_file'); }
          let file;
          try { file = await open(values[2], constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); }
          catch { throw new AvailKitError('input', 'secret_output_unavailable'); }
          let closed = false;
          let received = false;
          try {
            // This descriptor belongs to the exclusively created target, never an existing file.
            await file.chmod(0o600);
            const created = await client.createWebhook(data);
            received = true;
            privateSecret = created.signingSecret;
            await file.writeFile(JSON.stringify(created) + '\n', 'utf8');
            await file.sync();
            await file.close();
            closed = true;
            result = { id: created.id, url: created.url, enabled: created.enabled, createdAt: created.createdAt, secretSaved: true };
          } catch (error) {
            if (received) throw new AvailKitError('protocol', 'webhook_secret_persistence_unknown');
            if (error instanceof AvailKitError && (error.outcome !== 'unknown')) {
              throw new AvailKitError(error.kind, 'webhook_create_rejected', error.status);
            }
            throw new AvailKitError('transport', 'webhook_create_unknown');
          } finally {
            if (!closed) await file.close().catch(() => {});
          }
          break;
        }
      }
      break;
    }
    case 'resource-create': result = await client.createResource(await body<ResourceInput>(values[0])); break;
    case 'hours-replace': result = await client.replaceHours(values[0], await body<Hours>(values[1])); break;
    case 'offering-create': result = await client.createOffering(await body<OfferingInput>(values[0])); break;
    case 'availability': result = await client.availability({ offeringId: values[0], from: values[1], to: values[2] }); break;
    case 'book': result = await client.book(await body<BookingInput>(values[0]), values[1]); break;
    case 'reschedule': result = await client.rescheduleBooking(values[0], await body<RescheduleInput>(values[1]), values[2]); break;
    case 'cancel': result = await client.cancel(values[0], values[1]); break;
    case 'events': result = await client.events({ after: values[0] === undefined ? undefined : Number(values[0]), limit: values[1] === undefined ? undefined : Number(values[1]) }); break;
  }
  // Also redact a malicious server reflection, including JSON-escaped credentials.
  const scrub = (x: unknown): unknown => {
    if (typeof x === 'string') {
      let text = x.split(credential).join('[redacted]');
      if (privateSecret) text = text.split(privateSecret).join('[redacted]');
      return text;
    }
    if (Array.isArray(x)) return x.map(scrub);
    if (typeof x === 'object' && x !== null) return Object.fromEntries(Object.entries(x).map(([k, v]) => [String(scrub(k)), scrub(v)]));
    return x;
  };
  write(JSON.stringify(scrub(result)) + '\n');
}

export function customerFailure(cause: unknown, mutation: boolean): string {
  const rejected = cause instanceof AvailKitError && (cause.kind === 'input' || cause.kind === 'api' && new Map<number, string[]>([
    [400, ['invalid_input']], [401, ['unauthorized', 'credential_invalid']], [403, ['scope_denied', 'capability_denied']],
    [404, ['not_found']], [409, ['customer_archived', 'quota_exceeded']],
  ]).get(cause.status ?? 0)?.includes(cause.code));
  return mutation && !rejected
    ? 'Customer write outcome is unknown and may have committed. No automatic retry was sent. Pause customer writes; inspect current records, then deliberately set aside this unresolved request before a new write. Reads cannot prove the original outcome.\n'
    : 'Customer request failed. Check input, current records and secret MANAGE access. No automatic retry was sent.\n';
}

export function customerErasureFailure(cause: unknown): string {
  const rejected = cause instanceof AvailKitError && (cause.kind === 'input' || cause.kind === 'api' && new Map<number, string[]>([
    [400, ['invalid_input']], [401, ['unauthorized', 'credential_invalid']],
    [403, ['scope_denied', 'capability_denied']], [404, ['not_found']],
  ]).get(cause.status ?? 0)?.includes(cause.code));
  return rejected
    ? 'Customer erasure request failed. Check CUSTOMER_ID, --confirm, configuration and secret MANAGE+PRIVACY access. No automatic retry was sent.\n'
    : 'Customer erasure outcome is unknown and may have committed. Pause all customer writes. No automatic retry was sent. Inspect current records, then explicitly set aside this unresolved request before a separate new write. Reads cannot prove the original outcome.\n';
}

function isEntrypoint(): boolean {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isEntrypoint()) {
  runCli(process.argv.slice(2), process.env, text => process.stdout.write(text)).catch(error => {
    if (error instanceof JsonFailure || error instanceof SetupFailure) { process.exitCode = 1; return; }
    if (process.argv[2] === 'business-export') {
      const allowed = error instanceof BusinessExportCliFailure ? error.guidanceAllowed : !containsCredential(businessExportFailure, process.env.AVAILKIT_CREDENTIAL);
      if (allowed) process.stderr.write(businessExportFailure);
      process.exitCode = 1; return;
    }
    if (process.argv[2] === 'customers-erase') {
      const guidance = customerErasureFailure(error), credential = process.env.AVAILKIT_CREDENTIAL;
      process.stderr.write(credential && (guidance.includes(credential) || guidance.includes(JSON.stringify(credential).slice(1, -1))) ? '' : guidance);
      process.exitCode = 1; return;
    }
    if (process.argv[2] === 'customers-export') {
      const credential = process.env.AVAILKIT_CREDENTIAL;
      const safe = credential && (customerExportFailure.includes(credential) || customerExportFailure.includes(JSON.stringify(credential).slice(1, -1))) ? '' : customerExportFailure;
      process.stderr.write(safe); process.exitCode = 1; return;
    }
    if (process.argv[2] === 'customer') {
      const guidance = customerFailure(error, ['create', 'replace', 'archive'].includes(process.argv[3]));
      const credential = process.env.AVAILKIT_CREDENTIAL;
      process.stderr.write(credential && (guidance.includes(credential) || guidance.includes(JSON.stringify(credential).slice(1, -1))) ? '' : guidance);
      process.exitCode = 1; return;
    }
    if (process.argv[2] === 'replays-prune') {
      const rejected = error instanceof AvailKitError && (error.kind === 'input' || error.kind === 'api' && [400, 401, 403].includes(error.status ?? 0));
      const guidance = rejected
        ? 'AvailKit replay cleanup failed. Check LIMIT (1..128), configuration and secret PRIVACY access. No automatic retry was sent.\n'
        : 'AvailKit replay cleanup outcome is unknown and may have committed. No automatic retry was sent. A new explicit call is another batch, not a replay or rollback.\n';
      const credential = process.env.AVAILKIT_CREDENTIAL;
      const safe = credential && (guidance.includes(credential) || guidance.includes(JSON.stringify(credential).slice(1, -1))) ? '' : guidance;
      process.stderr.write(safe); process.exitCode = 1; return;
    }
    if (process.argv[2] === 'export') {
      // No server codes, file paths, business data or causes enter export diagnostics.
      const credential = process.env.AVAILKIT_CREDENTIAL;
      const safe = credential && (exportFailure.includes(credential) || exportFailure.includes(JSON.stringify(credential).slice(1, -1))) ? '' : exportFailure;
      process.stderr.write(safe); process.exitCode = 1; return;
    }
    const detail = error instanceof AvailKitError ? `${error.kind}${error.status ? ` HTTP ${error.status}` : ''}` : 'input or request';
    const continuation = process.argv[2] === 'webhook' && process.argv[3] === 'create'
      ? 'No automatic retry or disable was sent. Inspect the private output file and list subscriptions; inspect/disable the unwanted target explicitly. A lost secret cannot be recovered. Do not blindly repeat create.'
      : process.argv[2] === 'reschedule' ? 'Preserve the original reschedule input, booking ID and key for explicit same-intent replay. No automatic retry, cancel or rebook was sent.'
      : process.argv[2] === 'usage' ? 'Check configuration and READ access; no automatic retry was sent.'
      : 'No automatic retry was sent. A mutation may have committed: preserve its input/key and inspect current state. Only deliberately replay the exact still-live keyed intent under current authority; an unkeyed request has no replay guarantee.';
    process.stderr.write(`AvailKit ${detail} failed. ${continuation}\n`);
    process.exitCode = 1;
  });
}
