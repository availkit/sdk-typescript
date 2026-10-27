import { resolveNodeCredential } from './node-credential.ts';
import { AvailKitError } from './errors.ts';
export interface SetupCheck { name: string; status: 'ok' | 'error' | 'info'; code: string; nextStep: string }
export interface SetupReport { schemaVersion: 1; ok: boolean; offline: true; checks: SetupCheck[] }
/** Only fixed diagnostic text leaves this function. No values, paths or causes. */
export async function diagnoseSetup(env: NodeJS.ProcessEnv): Promise<SetupReport> {
  const checks: SetupCheck[] = [];
  let validUrl = false;
  try {
    const url = new URL(env.AVAILKIT_BASE_URL ?? '');
    validUrl = ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { /* Report the field, never its contents. */ }
  checks.push({ name: 'base_url', status: validUrl ? 'ok' : 'error', code: validUrl ? 'base_url_valid' : 'invalid_base_url', nextStep: 'Set AVAILKIT_BASE_URL to the intended API origin, normally https://api.availkit.com.' });
  const workspace = /^[0-9a-f]{32}$/.test(env.AVAILKIT_WORKSPACE_ID ?? '');
  checks.push({ name: 'workspace', status: workspace ? 'ok' : 'error', code: workspace ? 'workspace_id_valid' : 'invalid_workspace_id', nextStep: 'Set AVAILKIT_WORKSPACE_ID to the full workspace ID shown in dashboard API keys.' });
  try {
    await resolveNodeCredential({ credential: env.AVAILKIT_CREDENTIAL || undefined, credentialFile: env.AVAILKIT_CREDENTIAL_FILE });
    checks.push({ name: 'credential', status: 'ok', code: 'credential_locally_valid', nextStep: 'Use auth check to verify READ authority online after confirming the intended workspace/environment.' });
  } catch (error) {
    const ambiguous = error instanceof AvailKitError && error.code === 'ambiguous_credential';
    const file = !ambiguous && env.AVAILKIT_CREDENTIAL_FILE !== undefined;
    checks.push({ name: 'credential', status: 'error', code: ambiguous ? 'ambiguous_credential' : file ? 'invalid_credential_file' : 'invalid_credential', nextStep: ambiguous ? 'Set exactly one of AVAILKIT_CREDENTIAL and AVAILKIT_CREDENTIAL_FILE.' : file ? 'Set AVAILKIT_CREDENTIAL_FILE to a readable owner-only regular file containing one credential; use chmod 600 and do not use a symlink.' : 'Set AVAILKIT_CREDENTIAL_FILE to a protected credential file, or set AVAILKIT_CREDENTIAL through a private environment.' });
  }
  checks.push({ name: 'authority', status: 'info', code: 'authority_not_verified_offline', nextStep: 'Confirm the credential belongs to the selected workspace and test/live environment in dashboard API keys. Doctor cannot verify server reachability, revocation or permissions. Use discover for minimum permission bits and auth check for online READ verification.' });
  return { schemaVersion: 1, ok: checks.every(check => check.status !== 'error'), offline: true, checks };
}
