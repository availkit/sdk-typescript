/** Offline command contract. IDs and input bodies use the public workspace API. */
type Schema = Record<string, unknown>;
const text = (description: string, extra: Schema = {}): Schema => ({ type: 'string', description, ...extra });
const id = text('Full ID returned by the API; never an object name.', { pattern: '^[0-9a-f]{32}$' });
const name = text('Nonblank, at most 160 Unicode characters; no control characters.', { minLength: 1, maxLength: 160 });
const utc = text('UTC RFC3339 timestamp ending Z, years 2000–2100, at most millisecond precision; valid calendar date.', { format: 'date-time', pattern: '^(?:20[0-9]{2}|2100)-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$' });
const integer = (minimum: number, maximum: number): Schema => ({ type: 'integer', minimum, maximum });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', additionalProperties: false, required, properties });
export const inputSchemas = {
  resource: object({ name, timeZone: text('IANA time zone, for example Europe/Istanbul.'), capacity: integer(1, 1000) }),
  offering: object({ name, resourceId: id, durationMinutes: integer(1, 1440) }),
  hours: object({ windows: { type: 'array', maxItems: 28, description: 'Monday=1, Sunday=7. Start must precede end. Windows on the same weekday cannot overlap. Empty array clears hours.', items: object({ weekday: integer(1, 7), start: text('Local HH:MM.', { pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' }), end: text('Local HH:MM; 24:00 is allowed.', { pattern: '^(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' }) }) } }),
  booking: object({ offeringId: id, start: utc, customerId: { ...id, description: 'Optional existing active customer ID. Requires BOOK+MANAGE; null is invalid.' } }, ['offeringId', 'start']),
  reschedule: object({ expectedStart: { ...utc, description: 'Current booking start used for compare-and-set; this is not a monotonic version.' }, start: utc }),
  customer: object({ displayName: name, email: { anyOf: [text('One @, nonempty parts, no whitespace/control characters.', { maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+$' }), { type: 'null' }] }, phone: { anyOf: [text('No control characters or whitespace other than ordinary spaces.', { minLength: 1, maxLength: 32 }), { type: 'null' }] } }, ['displayName']),
  webhook: object({ url: text('Public HTTPS webhook URL, at most 2048 printable ASCII characters. Private/network-denied targets are rejected by the server.', { format: 'uri', maxLength: 2048, pattern: '^https://' }) }),
} as const;
interface Argument { name: string; required: boolean; schema: Schema; inputSchema?: keyof typeof inputSchemas }
const arg = (name: string, schema: Schema = id, required = true): Argument => ({ name, required, schema });
const file = (inputSchema: keyof typeof inputSchemas): Argument => ({ name: 'INPUT.json', required: true, schema: text('UTF-8 JSON regular file, at most 65536 bytes; request body at most 16384 bytes.'), inputSchema });
const key = arg('IDEMPOTENCY_KEY', text('Retain for this exact intent; printable ASCII, 16–128 characters, no surrounding whitespace. This is not a credential.', { minLength: 16, maxLength: 128, pattern: '^[\\x20-\\x7e]{16,128}$' }));
const page = (search = false): Argument[] => [arg('AFTER_ID|-', text('Cursor from this collection/environment; literal - starts at the first page.'), false), arg('LIMIT', integer(1, 100), false), ...(search ? [arg('QUERY', text('Nonblank search, at most 160 Unicode characters, no control characters.'), false)] : [])];
const output = arg('NEW_PRIVATE_FILE', text('New file; must not exist. Owner-only permissions. Keep empty/partial output private after failure.'));
const confirm = arg('--confirm', { const: '--confirm' });
type Replay = 'read_only' | 'no_replay' | 'same_intent_key_24h' | 'new_bounded_batch';
interface Operation {
  command: string[]; arguments: Argument[]; permissions: { bits: number; names: string[]; credentialKind: 'secret' | 'none'; conditional?: string };
  effects: string[]; replay: Replay; automaticRetry: false; inputSchema?: keyof typeof inputSchemas; api?: { method: string; path: string }; notes?: string;
}
const permissionNames = (bits: number) => Object.entries({ READ: 1, BOOK: 2, MANAGE: 4, CATALOG: 8, PRIVACY: 32 }).filter(([, bit]) => bits & bit).map(([n]) => n);
const op = (command: string, args: Argument[], bits: number, effects: string[], replay: Replay, method?: string, path?: string, notes?: string): Operation => ({ command: command.split(' '), arguments: args, permissions: { bits, names: permissionNames(bits), credentialKind: bits ? 'secret' : 'none' }, effects, replay, automaticRetry: false, ...(args.some(a => a.inputSchema) ? { inputSchema: args.find(a => a.inputSchema)!.inputSchema } : {}), ...(method && path ? { api: { method, path } } : {}), ...(notes ? { notes } : {}) });
const operations: Operation[] = [];
for (const kind of ['resource', 'offering', 'customer'] as const) {
  const collection = `${kind}s`, bits = kind === 'customer' ? 4 : 8, readBits = kind === 'customer' ? 4 : 1;
  operations.push(
    op(`${kind} create`, [file(kind)], bits, [`Creates one ${kind}; consumes retained-object quota.`], 'no_replay', 'POST', `/${collection}`),
    op(`${kind} list`, page(true), readBits, [], 'read_only', 'GET', `/${collection}`),
    op(`${kind} get`, [arg(`${kind.toUpperCase()}_ID`)], readBits, [], 'read_only', 'GET', `/${collection}/{id}`),
    op(`${kind} replace`, [arg(`${kind.toUpperCase()}_ID`), file(kind)], bits, ['Full replacement of current fields; omitted customer contacts are cleared.'], 'no_replay', 'PUT', `/${collection}/{id}`),
    op(`${kind} archive`, [arg(`${kind.toUpperCase()}_ID`)], bits, ['Archives the object; historical records remain retained.'], 'no_replay', 'POST', `/${collection}/{id}/archive`),
  );
}
operations.push(
  op('auth check', [], 1, [], 'read_only', 'GET', '/usage', 'Verifies current secret READ authority via usage; does not enumerate all capabilities.'),
  op('hours get', [arg('RESOURCE_ID')], 1, [], 'read_only', 'GET', '/resources/{id}/hours'),
  op('hours replace', [arg('RESOURCE_ID'), file('hours')], 8, ['Replaces all weekly hours.'], 'no_replay', 'PUT', '/resources/{id}/hours'),
  op('booking list', page(), 1, [], 'read_only', 'GET', '/bookings'),
  op('booking get', [arg('BOOKING_ID')], 1, [], 'read_only', 'GET', '/bookings/{id}'),
  op('availability', [arg('OFFERING_ID'), arg('FROM_UTC', utc), arg('TO_UTC', utc)], 1, [], 'read_only', 'GET', '/availability', 'FROM must precede TO by at most seven days. Returns at most 256 slots; inspect a smaller range when needed.'),
  op('book', [file('booking'), key], 2, ['Creates booking, consumes quota, appends event and may enqueue configured email/webhook delivery.'], 'same_intent_key_24h', 'POST', '/bookings'),
  op('reschedule', [arg('BOOKING_ID'), file('reschedule'), key], 2, ['Moves booking; appends event and may enqueue configured email/webhook delivery.'], 'same_intent_key_24h', 'POST', '/bookings/{id}/reschedule'),
  op('cancel', [arg('BOOKING_ID'), key], 2, ['Cancels booking; appends event and may enqueue configured email/webhook delivery. Quota is not refunded.'], 'same_intent_key_24h', 'POST', '/bookings/{id}/cancel'),
  op('events', [arg('AFTER_SEQUENCE', integer(0, Number.MAX_SAFE_INTEGER), false), arg('LIMIT', integer(1, 100), false)], 1, [], 'read_only', 'GET', '/events', 'Inspect retentionFloor/highWater. event_cursor_expired requires deliberate restart from zero; history is not complete.'),
  op('usage', [], 1, [], 'read_only', 'GET', '/usage', 'Advisory snapshot; does not reserve quota or capacity.'),
  op('webhook create', [file('webhook'), arg('SECRET_OUTPUT_FILE', output.schema)], 4, ['Creates subscription and reserves/syncs a new owner-only private file containing the one-time signing secret. Never prints the secret.'], 'no_replay', 'POST', '/webhooks', 'A lost signing secret cannot be recovered; inspect private file and subscriptions before another explicit create.'),
  op('webhook list', page(), 4, [], 'read_only', 'GET', '/webhooks'),
  op('webhook disable', [arg('SUBSCRIPTION_ID')], 4, ['Prevents future dispatch; cannot recall an admitted network attempt.'], 'no_replay', 'POST', '/webhooks/{id}/disable'),
  op('webhook deliveries', [arg('SUBSCRIPTION_ID'), ...page()], 1, [], 'read_only', 'GET', '/webhooks/{id}/deliveries', 'Status is an observation; pending/sending/unknown does not mean delivered.'),
  op('replays-prune', [arg('LIMIT', integer(1, 128))], 32, ['Deletes eligible expired replay receipts. Does not erase bookings, events, WAL or backups.'], 'new_bounded_batch', 'POST', '/maintenance/expired-replays'),
  op('history-prune', [arg('KIND', { enum: ['deliveries', 'events', 'bookings'] }), arg('LIMIT', integer(1, 128)), confirm], 36, ['Irreversibly prunes eligible 30-day history; quota is not refunded. Each invocation is a new batch.'], 'new_bounded_batch', 'POST', '/maintenance/history', 'Prune terminal deliveries, then event prefix, then bookings. No automatic loop or follow-up read.'),
  op('customers-erase', [arg('CUSTOMER_ID'), confirm], 36, ['Irreversibly erases current name/email/phone. Keeps ID, links, receipts, events, quota, exports, WAL and backups.'], 'no_replay', 'POST', '/customers/{id}/erase'),
  op('customers-export', [output], 4, ['Writes active/archived customer contacts to a new private 0600 JSONL file; no resume/cleanup on failure.'], 'read_only', undefined, undefined, 'Multiple bounded reads; not a transactional snapshot.'),
  op('export', [arg('OUTPUT.jsonl', output.schema), arg('--max-calls N', integer(1, 2048), false), arg('--work-seconds S', integer(1, 60), false)], 5, ['Writes workspace records to a new private 0600 JSONL file. Excludes customer contact records.'], 'read_only', undefined, undefined, 'Multiple bounded reads; not a snapshot. Defaults: max-calls=2048, work-seconds=30. Each option is allowed once; options may appear in either order.'),
  op('business-export', [arg('OUTPUT.jsonl', output.schema), arg('--max-calls N', integer(1, 2048), false), arg('--work-seconds S', integer(1, 60), false)], 5, ['Writes all nine retained business/contact/configuration sections to one new private 0600 JSONL file; no server archive or business mutation.'], 'read_only', 'GET', '/export', 'READ+MANAGE together on every page; no PRIVACY permission. All nine sections are included. Private contact values and webhook URL paths must remain private. Independent per-response snapshots; no point-in-time completeness promise. Defaults: max-calls=2048, work-seconds=30; maximums2048 and60. Fixed50000line/32MiB output cap. Each option once in either order; no automatic retry, restart, resume or cleanup. Any failure leaves incomplete private output, even if an end marker exists.'),
);
operations.find(o => o.command[0] === 'book')!.permissions.conditional = 'If input.customerId is present, also requires MANAGE (4), total bits=6.';
for (const [alias, target] of [['resource-create', 'resource create'], ['offering-create', 'offering create'], ['hours-replace', 'hours replace']]) {
  const original = operations.find(o => o.command.join(' ') === target)!;
  operations.push({ ...original, command: [alias], notes: `Alias for ${target}.` });
}
for (const command of ['discover', 'doctor', 'help']) operations.push(op(command, [], 0, [], 'read_only'));
export const commandDiscovery = {
  schemaVersion: 1,
  invocation: 'availkit [--json] COMMAND [arguments]',
  globalOptions: { '--json': 'Optional first argument only. One JSON envelope on stdout; failures exit nonzero. No credentials in arguments.' },
  configuration: {
    required: ['AVAILKIT_BASE_URL', 'AVAILKIT_WORKSPACE_ID'],
    credential: { exactlyOne: ['AVAILKIT_CREDENTIAL', 'AVAILKIT_CREDENTIAL_FILE'], file: 'Owner-only regular file containing one credential, at most 4096 bytes. One final LF/CRLF allowed; no symlinks.' },
    environment: 'Explicit workspace ID and chosen credential select authority. Credential is bound to test or live; there is no implicit environment switch or profile.',
  },
  output: { outcomes: ['confirmed_success', 'not_sent', 'rejected', 'unknown'], failuresExitNonzero: true, errorsContainResponseBodies: false },
  safety: { automaticRetries: false, unknown: 'May have committed. Preserve input and any intent key. Reads show current state and do not prove the original outcome. Never automatically resend.', keyedReplay: 'Only deliberately replay the exact original input/key under current authority within 24 hours. Expired keys can start a new mutation.', unkeyedReplay: 'No replay guarantee. Pause writes, inspect current state, and deliberately set aside the unresolved request before a new write.', pagination: 'Lists return one page; use returned nextAfter only in the same collection/environment.', recovery: 'No account recovery operation is available in this workspace CLI. Current same-origin v2 recovery is separately profile-gated.' },
  api: { basePath: '/v1/workspaces/{workspaceId}', reference: 'https://api.availkit.com/openapi.json' },
  inputSchemas,
  operations,
};
/** Never echo user-supplied arguments in diagnostics. */
export function commandName(args: string[]): string {
  const match = [...operations].sort((a, b) => b.command.length - a.command.length).find(o => o.command.every((v, i) => args[i] === v));
  return match?.command.join(' ') ?? (args[0] === '--help' ? 'help' : 'unknown');
}
