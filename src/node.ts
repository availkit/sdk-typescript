import { createHash } from 'node:crypto';
import { AvailKitClient, AvailKitError } from './index.ts';
import type { ClientOptions } from './index.ts';
import { resolveNodeCredential } from './node-credential.ts';

/** Explicit workspace authority with exactly one Node credential source. */
export type NodeClientOptions = Omit<ClientOptions, 'credential' | 'browserSession'> & {
  browserSession?: never;
} & ({ credential: string; credentialFile?: never } | { credential?: never; credentialFile: string });

/** Credential identity for comparing private saved intents; never an authentication credential. */
export interface NodeAvailKitClient extends AvailKitClient {
  readonly credentialFingerprint: string;
  readonly operationScope: Readonly<{ baseUrl: string; workspaceId: string; credentialFingerprint: string }>;
}

class NodeClient extends AvailKitClient implements NodeAvailKitClient {
  #credentialFingerprint: string;
  #operationScope: Readonly<{ baseUrl: string; workspaceId: string; credentialFingerprint: string }>;
  constructor(options: ClientOptions & { credential: string }) {
    super(options);
    this.#credentialFingerprint = createHash('sha256').update(options.credential).digest('hex');
    this.#operationScope = Object.freeze({baseUrl:new URL(options.baseUrl).href.replace(/\/$/, ''),workspaceId:options.workspaceId,credentialFingerprint:this.#credentialFingerprint});
  }
  get credentialFingerprint(): string { return this.#credentialFingerprint; }
  get operationScope() { return this.#operationScope; }
}

/**
 * Read a private credential file once and create an ordinary send-once client.
 * File contents are one credential, optionally followed by LF or CRLF; the file
 * must be an owner-only regular file of at most 4096 bytes, owned by this user.
 * No environment variables are read. Use the main package entry in browsers.
 */
export async function createNodeClient(options: NodeClientOptions): Promise<NodeAvailKitClient> {
  if (options.browserSession !== undefined) throw new AvailKitError('input', 'ambiguous_credential');
  const credential = await resolveNodeCredential(options);
  const { credentialFile: _credentialFile, ...clientOptions } = options;
  return new NodeClient({ ...clientOptions, credential });
}

// Node-only persistence; importing ./node never imports the experimental SQLite module.
export { NodeOperationIntent, prepareNodeOperation, executeNodeOperation } from './operation-intent.ts';
export type { NodeOperationInput } from './operation-intent.ts';
export { OperationRecord, OperationStoreError } from './operation-store.ts';
export type { OperationState, OperationStore } from './operation-store.ts';
export { FileOperationStore } from './operation-files.ts';
