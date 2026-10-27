# AvailKit agent instructions

Use the installed `availkit` CLI. Run `availkit discover` first: its offline JSON
catalog gives exact arguments, closed JSON input schemas, minimum capability bits,
secret credential requirements, side effects and replay policy for every shipped
command. `availkit help` is also offline. Legacy v1 recovery is unavailable. Current v2 recovery is a separate same-origin browser protocol, gated by its explicit profile; the workspace CLI has no recovery command.

Set `AVAILKIT_BASE_URL` and the explicit full `AVAILKIT_WORKSPACE_ID`. Choose the
credential for the intended test/live environment; environment is bound to that
credential, never inferred from a name. Set exactly one of `AVAILKIT_CREDENTIAL_FILE`
(owner-only regular file, for example chmod 600) and `AVAILKIT_CREDENTIAL` through a
private environment. Never put credentials in arguments, instructions or logs.
Use the least permissions shown by discovery. `availkit doctor` validates setup
locally without sending a request; it does not verify server authority. After
confirming scope, `availkit --json auth check` verifies secret READ authority online.

For automation, place `--json` first: `availkit --json COMMAND [arguments]`. Stdout
is one versioned envelope; failures exit nonzero. Read `outcome` before continuing:

- `confirmed_success`: the response passed validation; `data` contains the result.
- `not_sent`: local input/configuration prevented the request.
- `rejected`: a recognized API rejection confirmed the request failed.
- `unknown`: the response did not establish an outcome. A mutation may have committed.

Never automatically retry a mutation. Preserve its exact input, booking ID and
idempotency key. A human-authorized replay must use the same still-live intent,
input and key under current authority within 24 hours; an expired key may create
a new mutation. Unkeyed writes have no replay guarantee: pause writes, inspect
current records, and deliberately set aside the unresolved request before a new
write. Reads show current state and cannot prove the original outcome. Do not
cancel, recreate, disable or clean up as an automatic response to uncertainty.

Use JSON files for request bodies. Discovery's `inputSchemas` defines their shape.
List commands return one page; carry `nextAfter` only within the same collection
and environment. Respect event retention boundaries. Webhook create saves its
one-time signing secret in a new private file; never print or read it into logs.
Exports intentionally contain private data; partial files remain private and
incomplete on failure. Customer erasure and history cleanup require explicit
confirmation. Only perform writes and destructive commands authorized by the user.

For full API reference use https://api.availkit.com/openapi.json and the developer
guide https://availkit.dev/sdk. SDK-only account/public operations are separate
from the workspace CLI catalog. MCP is not required for this integration.
