# AvailKit TypeScript SDK and CLI

SDK **0.4.0**. Standalone build and synthetic test instructions are in
[DEVELOPMENT.md](DEVELOPMENT.md). [Versioned release notes](https://github.com/availkit/sdk-typescript/releases)
record dated verification and available distribution channels. Source availability
does not imply registry publication or mobile/service acceptance.
Install examples name this SDK version; check the release notes for artifact availability.

Independent client for the accepted AvailKit Rust API. Node24 or newer is required
for the CLI/examples. Runtime JavaScript has no package dependencies. The package
can be installed from the server-built archive at https://availkit.dev/downloads/availkit-booking-0.4.0.tgz. Local builds remain supported. Production API: https://api.availkit.com; dashboard: https://app.availkit.com; developer guide: https://availkit.dev/sdk.

## Build and install locally

From this SDK source directory:

```sh
npm ci --ignore-scripts
npm run build
npm pack . --ignore-scripts --pack-destination /YOUR/PRIVATE/DIRECTORY
```

From a new consumer project, install the resulting archive:

```sh
npm install /YOUR/PRIVATE/DIRECTORY/availkit-booking-0.4.0.tgz
npx --no-install availkit --help
```

The archive contains compiled ESM JavaScript and declarations. Import
`@availkit/booking` for the workspace SDK or `@availkit/booking/human` for the
browser human API. No TypeScript runtime loader is needed inside node_modules.

## Public customer integrations

Use `@availkit/booking/public` for the cookie-free guest SDK. Publish a booking
page through the dashboard or explicitly scoped workspace client, then use its
public page ID. No management key belongs in the customer app.
[Runnable browser/server examples and setup](https://availkit.dev/guides/custom-frontend)
cover booking, private links, moving/cancelling, exact replay, pause, expiry and
restore boundaries. The public client never automatically retries.

## Connect and authenticate

For the hosted service, sign in at https://app.availkit.com and open **API keys**.
Choose the exact workspace and **test** environment. Create a key with **Read** and
**Book** for the first-booking guide, download its once-only secret, and copy
the displayed workspace ID. Keep the secret file private and outside source
control. A read-only integration only needs Read. Use the dashboard's Catalog &
hours section to prepare a resource, weekly hours and offering without expanding
that integration key's permissions.

The [hosted SDK guide](https://availkit.dev/sdk#first-booking) walks through a fresh
installation to a confirmed booking, with an exact request saved before the send.
The CLI can read the same booking using `availkit booking get BOOKING_ID`.
If a send has an uncertain outcome, keep that intent and inspect current state;
never rerun the whole example or generate a replacement intent automatically.

For an explicitly self-hosted service, follow that service's account and workspace
setup instructions. Account enrollment and passkeys use the same explicit session workflow. Existing
API bearer keys do not replace human owner/session authority. The following
browser API example is for a custom same-origin account integration; routine key
management is available in the dashboard and needs no browser console.

Use `HumanClient` in a page on the API's own origin. It uses same-origin browser
cookies, captures CSRF from explicit `session()` reads and sends it on subsequent
calls. Enrollment/login/add/reauthentication ceremonies are explicit typed methods;
pass their JSON options through WebAuthn and send the serialized credential to
the corresponding finish method. Refresh `session()` after login/reauthentication.
It has no local session injection, cross-origin login or built-in CLI browser.

```ts
import { HumanClient } from '@availkit/booking/human';
const human = new HumanClient({ baseUrl: location.origin });
await human.browser();
// Perform the explicit email proof + passkey ceremony, then:
const session = await human.session();
const key = await human.issueKey({
  organization_id: session.scope!.organization_id,
  workspace_id: session.scope!.workspace_id,
  environment: 'test', kind: 'secret', capabilities: 3, // READ + BOOK
}, 'YOUR_SAVED_KEY_ISSUANCE_INTENT');
// Store key.secret privately once. Never log the response.
```

Capabilities for the workspace SDK: READ1; BOOK2 for create/move/cancel; MANAGE4
for contacts, contact export and webhook subscription configuration; CATALOG8 for
resources/hours/offerings; PRIVACY32 for replay pruning (plus MANAGE for contact
erasure/history pruning). Bit16 has no selectable function in the current
workspace integration API. Grant only what the integration needs. Verified memberships have an explicit scoped ceiling;
membership narrowing/removal invalidates older-revision keys. Issuance uses a
caller-retained intent key but exact replay does not reveal the secret again.
Legacy `HumanClient.browser()` retains `recovery_available:false`, and its v1
recovery endpoints remain unavailable. This preserves the shipped 0.3.0 protocol.
The additive `RecoveryClient` in 0.4.0 uses only `/v2/human/recovery/profile`,
`/start` and `/finish`; it never switches the legacy contract or retries a mutation.
Check `profile().recovery_available` before offering recovery. Disabled profiles
report `notice_delivery: "unavailable"`; enabled production profiles report
`"email_queued"`, while synthetic profiles report `"synthetic_only"` and make no
real-email delivery claim. Adding client support does not enable a server profile.

```ts
import { HumanClient, RecoveryClient } from '@availkit/booking/human';
const human = new HumanClient({ baseUrl: location.origin });
const recovery = new RecoveryClient({ baseUrl: location.origin });
const profile = await recovery.profile(); // Initializes/retains the same browser cookie.
// Offer the explicit recovery flow only if profile.recovery_available is true.
```

`recovery.start({email, code})` consumes one current recovery code before returning
normal WebAuthn creation options. Preserve their complete library fields; perform
the standard browser WebAuthn conversion and registration in your application,
then send its serialized public credential once through
`recovery.finish({ceremony_id, credential})`. Finish accepts no email proof code,
workspace credential, bearer header or idempotency key. Production success queues
a durable notice without waiting for provider delivery. Refresh
`human.session()` after finish to synchronize its CSRF token.

A timeout, transport failure or malformed/unrecognized mutation response is
`AvailKitError.outcome === "unknown"`. Keep the newly created authenticator and
pause security writes. Explicitly inspect `human.session()`; if no current session
is available, use the ordinary email-proof/new-passkey sign-in flow. A session read
does not reconstruct the original acknowledgment. Never automatically resend
finish, consume another code, replace codes or delete the new authenticator.
Recognized structured 4xx rejections are `rejected`; local validation is `not_sent`.
The caller owns retained pending state and deliberate reconciliation. Codes and
ceremony inputs belong only in private mounted memory, never logs, URLs or browser
storage. Recovery remains a same-origin account protocol, outside the workspace
CLI and public/mobile booking clients. No historical interrupted-task acceptance
or provider-stop resolution is claimed by this additive implementation.

For the CLI, put the issued raw secret into an owner-only regular file (0600)
using a private editor. A single trailing newline is allowed. Then set:

```sh
export AVAILKIT_BASE_URL=https://api.availkit.com
export AVAILKIT_WORKSPACE_ID=YOUR_WORKSPACE_ID
export AVAILKIT_CREDENTIAL_FILE=/YOUR/PRIVATE/credential.txt
npx --no-install availkit auth check
```

`AVAILKIT_CREDENTIAL` is also supported for private process environments. Set one
credential source, not both. Secrets never belong in command arguments, shared
shell history or output. The CLI refuses symlinks/nonregular or loosely permitted
credential files. `auth check` needs READ; it observes usage, not a reservation.

## Node credential files

Use the Node-only entry point for the same protected file used by the CLI:

```js
import { createNodeClient } from '@availkit/booking/node';
const client = await createNodeClient({
  baseUrl: process.env.AVAILKIT_BASE_URL,
  workspaceId: process.env.AVAILKIT_WORKSPACE_ID,
  credentialFile: process.env.AVAILKIT_CREDENTIAL_FILE,
});
const offerings = await client.listOfferings({ limit: 25 });
```

`createNodeClient` accepts exactly one of `credentialFile` and `credential`.
It reads once during construction; later file edits do not silently change client
identity. `client.credentialFingerprint` is a read-only SHA256 identifier for the
original authority in a private saved intent, never an authentication credential.
Missing, unreadable, nonregular, final-symlink, wrong-owner, group/world-accessible,
empty, oversized or malformed UTF8 files fail before sending with the fixed
`invalid_credential_file` code. A single LF or CRLF is allowed; other whitespace
is refused. Both sources produce `ambiguous_credential`. Errors omit contents,
paths and transport causes. The shared loader follows the CLI's POSIX0600 owner
policy; parent directory and host access controls remain the operator's task.

The ordinary `@availkit/booking`, `/human` and `/public` entries retain direct
credential/session inputs and contain no filesystem dependencies. Never import
`/node` in a browser bundle. Run the exact guide example from a new consumer
project with a test key and offering:

```sh
mkdir -m700 private
# Put the downloaded key in private/availkit-test.key and chmod 600 it.
# Export BASE_URL, WORKSPACE_ID, CREDENTIAL_FILE and OFFERING_ID as in the guide.
cp node_modules/@availkit/booking/examples/first-booking.mjs .
node first-booking.mjs
```

The example saves its intent exclusively before one send. Keep that file and the
original key after any uncertainty; never delete it to rerun the example.

## AI-agent integration

A shell-capable agent can use the shipped CLI and [AGENTS.md](AGENTS.md). No MCP
server is needed for these operations. Configure credentials privately, tell the
agent the exact authorized workspace/environment and task, and start with:

```sh
npx --no-install availkit discover
npx --no-install availkit --json doctor
npx --no-install availkit --json auth check
npx --no-install availkit --json offering list
```

Discovery is offline versioned JSON with exact commands, argument order, input
schemas, capabilities, side effects, replay limits and pagination. `doctor` is an
offline local validation with fixed corrective steps; it does not prove server
authority or the key's environment. The key binds test/live at deliberate issuance;
no environment is automatically selected or changed. `auth check` sends one
read-only usage request requiring Read.

Put `--json` first to opt into versioned envelopes for any command. Success has
`outcome: confirmed_success` and `data`. Failure has a safe `error` and outcome
`not_sent`, `rejected` or `unknown`, with exit1. Stop mutations on unknown, preserve
the exact intent and original authority, and inspect current authorized state.
Reads cannot reconstruct a lost acknowledgment. No automatic retries or fresh
replacement intents are allowed. Ordinary CLI output remains supported.

## Dashboard browser sessions

The dashboard uses the signed-in account directly, without issuing an
API key. After the normal passkey ceremony and an explicit `human.session()`:

```ts
import { AvailKitClient } from '@availkit/booking';
const scope = session.dashboard_scopes!.find(s => s.environment === 'test')!;
const client = new AvailKitClient({
  baseUrl: location.origin,
  workspaceId: scope.workspace_id,
  browserSession: {
    environment: scope.environment,
    csrfToken: session.csrf_token,
    principal: scope.principal,
  },
});
const resources = await client.listResources({ limit: 25 });
```

Choose the workspace/environment explicitly. This mode requires the page's exact
origin, sends same-origin cookies plus CSRF/scope headers, and never sends a bearer
credential. Supply exactly one authentication mode. Refresh session discovery
after access changes and rebuild the client from the current scope. A saved
mutation/retry must retain its original account/environment/principal generation;
never reconstruct it using a newly granted scope. Session expiry/logout and
membership narrowing/removal apply to every request, including old receipts.
The CLI and private exports continue to use explicit integration keys.

`AVAILKIT_IDENTITY_ORIGIN` supports exact named HTTPS origins as well as the
matching `http://localhost:PORT` local test profile. HTTPS uses the exact hostname
as WebAuthn RP and Secure cookies. Synthetic preview-mailbox behavior is an
explicit server opt-in and is not a production delivery guarantee.

## SDK workflow

```ts
import { AvailKitClient } from '@availkit/booking';
const client = new AvailKitClient({ baseUrl, workspaceId, credential });
const resource = await client.createResource({name:'Desk',timeZone:'UTC',capacity:1});
await client.replaceHours(resource.id, {windows:[{weekday:1,start:'09:00',end:'17:00'}]});
const offering = await client.createOffering({name:'Visit',resourceId:resource.id,durationMinutes:30});
const availability = await client.availability({offeringId:offering.id,from,to});
// Choose valid future UTC instants from availability; save input/keys before send.
const booked = await client.book({offeringId:offering.id,start:availability.slots[0].start}, savedBookKey);
const current = await client.getBooking(booked.id);
await client.rescheduleBooking(current.id,{expectedStart:current.start,start:availability.slots[1].start},savedMoveKey);
await client.cancel(current.id,savedCancelKey);
```

Resource/offering names, allocation fields, archives and contact CRUD/erasure are
explicit methods. Catalog allocation edits can conflict with future bookings.
Archive retains history/quotas and stops new allocations. Linked booking input
uses customerId and BOOK+MANAGE; ordinary contacts need MANAGE, erase additionally
PRIVACY. Webhook create returns a signing secret once; save privately before
further work. No worker is launched by the SDK or CLI.

List methods return one page. Resource/offering/customer lists accept literal
case-insensitive `q` and `{after,limit}`; booking/webhook lists use ID pagination.
`resourcePages`, `offeringPages`, `customerPages`, `bookingPages`, `webhookPages`,
`deliveryPages` and `eventPages` provide explicit bounded async iteration. Use
`maxPages` (default100, maximum1000); exhaustion throws rather than silently
claiming a complete export. Pages are current per-response observations, not a
transactional snapshot. Cursors belong to their collection/environment/filter.

Events include `retentionFloor` and `highWater`. Nonzero cursors below the floor
return event_cursor_expired; there is no silent restart. Starting explicitly from
zero requests the retained suffix. History maintenance reclaims eligible30day-old
terminal deliveries, then a contiguous event prefix, then unreferenced old bookings;
limits are1..128 and it never refunds monthly creates. Usage exposes8counters,
including retained customers after archive/erase.

## CLI workflow and private files

`availkit --help` lists exact commands. Catalog JSON files are closed API inputs.
Examples:

```sh
npx --no-install availkit resource create resource.json
npx --no-install availkit resource list - 25 'Desk'
npx --no-install availkit hours replace RESOURCE_ID hours.json
npx --no-install availkit offering create offering.json
npx --no-install availkit availability OFFERING_ID FROM_UTC TO_UTC
npx --no-install availkit book saved-book.json SAVED_BOOK_KEY
npx --no-install availkit booking get BOOKING_ID
npx --no-install availkit reschedule BOOKING_ID saved-move.json SAVED_MOVE_KEY
npx --no-install availkit cancel BOOKING_ID SAVED_CANCEL_KEY
npx --no-install availkit events 0 100
npx --no-install availkit usage
```

Use resource/offering get/replace/archive, hours get, booking list, customer
create/list/get/replace/archive, customers-erase ID --confirm, webhook
create/list/disable/deliveries, replays-prune LIMIT, and history-prune KIND LIMIT
--confirm. Each maintenance call is a new bounded batch. `webhook create` requires
a new private output file reserved before send; its once-only signing secret is
saved/synced there and excluded from stdout. `export` writes workspace metadata
without contacts/signing secrets (format version2 includes an event-retention
metadata record identifying the retained suffix floor/high-water); `customers-export` explicitly writes retained
contact rows to a separate new0600file. Keep failed empty/partial files private.
Logical erase does not wipe old exports, WAL or backup bytes.

## Errors and uncertain outcomes

Each SDK call/CLI invocation sends once. It never retries automatically, follows
redirects, compensates by creating/cancelling another booking, or interprets a
503 as proof of rollback. JSON and RFC problem errors preserve safe fixed machine
codes/status while excluding server text, response bodies and transport causes.
`AvailKitError` exposes kind, code, status and outcome: not_sent, rejected, unknown.
Unknown/reflected codes become api_error. A client deadline/invalid response/lost
response may follow a durable commit. Errors/read observations cannot reconstruct
the original acknowledgment. The CLI returns0on success and1on failure.

Keep exact input, key, time and workspace/environment/principal identity privately.
Only deliberately replay the exact still-live keyed booking intent under current
authority within24hours. Changed intent conflicts. Expired keys can start a new
mutation. Unkeyed catalog/contact/webhook/maintenance writes have no replay
guarantee: inspect current authorized state and make an informed new decision.
Never blindly rerun a whole example after uncertainty. Preserve its private receipt
and stop; do not automatically retry, regenerate keys or undo unknown work.

## Runnable examples and synthetic verification

Run the standalone source checks from this SDK repository root, as documented in
[DEVELOPMENT.md](DEVELOPMENT.md):

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
mkdir -p artifacts
npm pack . --ignore-scripts --pack-destination artifacts
```

These checks use synthetic transports and controlled loopback fixtures. They need
no service account or API credential. Dated service, deployment and browser
acceptance is recorded separately in the versioned release notes.

The installed npm archive includes `examples/first-booking.mjs` and
`examples/durable-booking.mjs`. The first creates a booking, retains its private
original before sending, saves the acknowledged result and reads that booking.
Use an actual test key and owned test offering, configure the environment and
credential file above, then run from a new consumer project:

```sh
umask 077
mkdir -m 700 private
node node_modules/@availkit/booking/examples/first-booking.mjs
```

Keep the private directory after an error; an existing original blocks a second
create. The durable example uses the maintained filesystem or SQLite operation
store and separate deliberate actions. Follow its configuration and action
commands below; reopening or inspecting a store never sends automatically.

### Durable Node booking operations (0.4.0)

`@availkit/booking/node` now includes `prepareNodeOperation`,
`executeNodeOperation` and `FileOperationStore` for trusted workspace create,
move and cancel. These helpers are Node-only. They add no browser/public/human
replay guarantee. Use the actual credential for the chosen test/live environment;
the explicit environment argument is a local scope label, not an authority check.

```js
import {createNodeClient,prepareNodeOperation,executeNodeOperation,
  FileOperationStore} from '@availkit/booking/node';
const client = await createNodeClient({baseUrl:'https://api.availkit.com',
  workspaceId, credentialFile});
const store = new FileOperationStore('/private/owned0700/operations');
// Keep one stable local ID for this logical request across every restart.
const localId = '00000000000000000000000000000001';
const original = prepareNodeOperation(client, {environment:'test', operation:'book',
  body:{offeringId,start}, idempotencyKey:crypto.randomUUID()});
const prepared = store.create(localId, original); // conflicting original refuses
const attempt = store.begin(localId, prepared.revision, original);
// UNKNOWN is fsynced before begin returns. Only this explicit line sends once.
try {
  await executeNodeOperation(client, 'test', original);
} catch (error) {
  // Keep the unknown original. Settle only using the SDK's explicit outcome.
  // A local not_sent can remain conservatively unknown in the store.
  store.settle(localId, attempt.revision, attempt.attemptToken(),
    error.outcome === 'rejected' ? 'rejected' : 'unknown');
  throw error;
}
store.settle(localId, attempt.revision, attempt.attemptToken(), 'confirmed');
store.close();
```

In real code close the store in `finally`, including failures. The example above
illustrates the transition; the bundled `examples/durable-booking.mjs` supplies
complete actions and safe error output. Rerunning `prepare` refuses the retained
row before generating another original. `inspect` only reads local state and
`reconcile` reads one bounded booking page; neither sends a mutation nor proves
the original outcome. Scope, body bytes, key and preparation time remain fixed.
The store does not save the booking response or IDs returned by the server.

For SQLite, explicitly import `SQLiteOperationStore` from
`@availkit/booking/node/sqlite` and use it in place of `FileOperationStore`.
It uses the built-in `node:sqlite` module, experimental on Node24, without another
runtime dependency. Normal `./node` imports do not load SQLite. Both adapters
currently require Linux and a trusted local owned0700 directory. Regular files
are owned0600; symlink components, symlink/special-file records and broad modes
are refused. SQLite owns `operations.sqlite` and its journal in that directory;
do not change them or share the directory with other software while open.

```sh
umask 077
mkdir -p private
mkdir -m 700 private/operations
export AVAILKIT_BASE_URL=https://api.availkit.com
export AVAILKIT_WORKSPACE_ID=REPLACE_WITH_WORKSPACE_ID
export AVAILKIT_ENVIRONMENT=test
export AVAILKIT_CREDENTIAL_FILE=/private/path/owned0600-test-key
export AVAILKIT_OFFERING_ID=REPLACE_WITH_OWNED_OFFERING_ID
export AVAILKIT_START=REPLACE_WITH_FUTURE_AVAILABLE_UTC_TIMESTAMP
export AVAILKIT_OPERATION_DIR="$PWD/private/operations"
export AVAILKIT_OPERATION_BACKEND=file # or sqlite in its own directory
node node_modules/@availkit/booking/examples/durable-booking.mjs prepare
node node_modules/@availkit/booking/examples/durable-booking.mjs inspect
node node_modules/@availkit/booking/examples/durable-booking.mjs send
```

Create `private/` first if needed; keep it outside source control and save the
credential directly from its reveal into the0600 file. The example requires an explicit test label; supply an actual test credential,
because that label cannot change server authority. On uncertainty stop sends, join all
workers and run `reconcile`. If an active claim survived process interruption,
a separate deliberate `acknowledge-interruption` action requires
`AVAILKIT_ACK_WORKERS_JOINED=yes`; it releases the local claim and establishes no
server outcome. A subsequent explicit `replay` action admits/sends that original
once within24 hours of preparation. No expired intent can be reopened with a new
key through the helper. Current server retention and authority still apply.

Filesystem crash locks have no timer: `recoverLock(true)` is a separate owner
assertion after all workers joined, and refuses if an unfinished `.pending`
snapshot exists. Keep that snapshot and inspect privately; no API guesses whether
to publish/delete it. SQLite transactions instead release their DB lock when the
process exits; the operation's unknown claim remains until explicit disposition.

Bounds are128 records,64KiB/record,256 revisions,64 admitted attempts and16MiB
SQLite storage. Full stores fail closed, with no eviction/auto cleanup. Records
and originals have safe default JSON/inspection; `original().exportPrivate()` and
`attemptToken()` deliberately expose private material. Never log those exports.
This is plaintext private storage, not encryption, a distributed queue, a lease,
a transaction spanning the API, or protection from same-UID/root software,
storage rollback or host loss. Applications own private backup/retention and
intentional archival after resolution. Other SDKs do not inherit this adapter.


A stored state describes the original logical operation, not just the latest
attempt. If an earlier send was unknown, a later explicit replay's403/409 or other
recognized rejection cannot prove that earlier send failed. Both stores centrally
normalize `settle(..., rejected)` after more than one admitted attempt to
`unknown`, clear only the completed attempt claim and retain the exact original.
A first attempt's definite rejection can be terminal. The runnable examples label
the latest `attemptOutcome` separately from the retained `operationState`.


Manual filesystem lock recovery requires every writer, new worker starter and
other recovery operator to remain quiescent for the entire removal operation.
Joining only a previously crashed worker is insufficient if another process can
start concurrently. There is no concurrent manual-repair protocol; stop the
application's workers before private repair and resume them only after it returns.

The Node intent adapter accepts an API origin URL only (no path prefix), using
HTTPS or HTTP on localhost/loopback for controlled local verification. The base
workspace client still supports its existing URL configuration; a custom path
prefix is outside this intent adapter's delivered scope.


See [CHANGELOG.md](CHANGELOG.md), [SUPPORT.md](SUPPORT.md) and
[SECURITY.md](SECURITY.md) for release policy and private reporting prerequisites.
`contract-projection.json` pins only this SDK's supported wire operations;
additive unrelated API routes do not imply this SDK implements them.
