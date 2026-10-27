import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { AvailKitError } from './errors.ts';

/** Internal Node-only credential source shared by the SDK factory and CLI. */
export async function resolveNodeCredential(options: { credential?: string; credentialFile?: string }): Promise<string> {
  if (options.credential !== undefined && options.credentialFile !== undefined) {
    throw new AvailKitError('input', 'ambiguous_credential');
  }
  if (options.credentialFile === undefined) {
    if (typeof options.credential !== 'string' || !options.credential || /[\s\x00-\x1f\x7f]/.test(options.credential)) {
      throw new AvailKitError('input', 'invalid_credential');
    }
    return options.credential;
  }
  try {
    if (typeof options.credentialFile !== 'string' || !options.credentialFile) throw new Error();
    // Open once, refuse a final symlink, and avoid blocking on a FIFO. Validate
    // and read that same descriptor so a path replacement cannot change its target.
    const file = await open(options.credentialFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 4096 || (stat.mode & 0o077) !== 0
          || process.getuid && stat.uid !== process.getuid()) throw new Error();
      const bytes = Buffer.alloc(4097);
      let used = 0;
      while (used < bytes.length) {
        const result = await file.read(bytes, used, bytes.length - used, null);
        if (!result.bytesRead) break;
        used += result.bytesRead;
      }
      if (used > 4096) throw new Error();
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)).replace(/\r?\n$/, '');
      if (!value || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error();
      return value;
    } finally { await file.close(); }
  } catch {
    // Filesystem errors carry paths and can contain sensitive file contents.
    // Deliberately retain neither the original error nor a cause.
    throw new AvailKitError('input', 'invalid_credential_file');
  }
}
