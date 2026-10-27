import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { AvailKitClient } from '../../src/index.ts';
import { runReschedule } from './reschedule.ts';

try {
  const [inputPath, receiptPath] = process.argv.slice(2);
  const { AVAILKIT_BASE_URL: baseUrl, AVAILKIT_WORKSPACE_ID: workspaceId, AVAILKIT_CREDENTIAL: credential } = process.env;
  if (process.argv.length !== 4 || !inputPath || !receiptPath || !baseUrl || !workspaceId || !credential) throw new Error();
  const file = await open(inputPath, constants.O_RDONLY | constants.O_NONBLOCK);
  let plan;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error();
    const bytes = Buffer.alloc(65537); let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > 65536) throw new Error();
    plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
  } finally { await file.close(); }
  const client = new AvailKitClient({ baseUrl, workspaceId, credential });
  // Reserve an exclusive private receipt before any send; never overwrite an old journey.
  const receipt = await open(receiptPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    await receipt.chmod(0o600);
    const result = await runReschedule(client, plan, async state => {
      const line = JSON.stringify(state);
      if (line.includes(credential)) throw new Error();
      // Append rather than truncate: preserve earlier intent/receipts on a later write failure.
      await receipt.writeFile(line + '\n', 'utf8');
      await receipt.sync();
    });
    console.log(JSON.stringify({ status: result.status, eventCount: result.eventCount }));
  } finally { await receipt.close(); }
} catch {
  console.error('Reschedule journey stopped. Inspect the private plan/receipt; preserve the original booking ID, input and key for explicit same-intent replay. No automatic retry or compensating cancel/rebook was sent.');
  process.exitCode = 1;
}
