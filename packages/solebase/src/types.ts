/** Solebase Layer 1 shared types. */

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export type SyncProvider = 'drive' | 's3';

/**
 * Sync options for S3 / Drive blob store + optional WebRTC P2P.
 * Encryption always uses SolebaseConfig.encryptionKey (never plaintext on the wire).
 */
export interface SyncOptions {
  /** Force in-memory blob store (smoke / offline unit tests). */
  memory?: boolean;
  /** Allow MemoryBlobStore when S3 credentials are incomplete (default true). */
  allowMemoryFallback?: boolean;
  /** S3 endpoint (path-style), e.g. https://xxx.r2.cloudflarestorage.com */
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Blob key prefix (default solebase-changesets). */
  prefix?: string;
  /**
   * Use zero-LIST manifest sync for S3 (default true when credentials present).
   * Set false only for legacy ListObjects debugging.
   */
  useManifest?: boolean;
  /** Prune manifest chunks older than N days during push (default 30; 0 = off). */
  retentionDays?: number;
  /** Drive stub: OAuth access token (live API not wired yet). */
  accessToken?: string;
  folderId?: string;
  /** Enable WebRTC P2P alongside blob sync. */
  p2p?: boolean | Record<string, unknown>;
  /** Auto push/pull on local writes + poll (default true when sync configured). */
  autoSync?: boolean;
  pollIntervalMs?: number;
  debounceMs?: number;
  /** Inject a pre-built blob store (tests). */
  blobStore?: unknown;
  [key: string]: unknown;
}

export interface SyncConfig {
  provider: SyncProvider;
  options?: SyncOptions;
}

export interface SolebaseConfig {
  /** Logical app / database id (used for OPFS filename). */
  appId: string;
  /** E2EE key for changeset encrypt/decrypt (S3/Drive + P2P). */
  encryptionKey: string;
  /** Async sync: S3 or Drive-shaped blobs + optional WebRTC P2P. */
  sync?: SyncConfig;
  /**
   * OPFS database filename override (default `solebase-${appId}.db`).
   * Use distinct filenames when simulating multiple devices in one origin (smoke).
   */
  filename?: string;
  /** Override module-worker URL (default: core/db-worker.js relative to the importer). */
  workerUrl?: string | URL;
  /** Optional crsqlite.wasm override. */
  wasmUrl?: string;
}

/** Document base — every collection row has a string id. */
export interface Document {
  id: string;
  [key: string]: unknown;
}

/** Layer 1 RPC request types over WorkerBridge. */
export type RpcType =
  | 'EXEC'
  | 'QUERY'
  | 'NOTIFY'
  | 'INIT'
  | 'CLOSE'
  | 'changeset_apply'
  | CollectionRpcType;

export type CollectionRpcType =
  | 'collection_ensure'
  | 'collection_insert'
  | 'collection_update'
  | 'collection_delete'
  | 'collection_findById'
  | 'collection_find';

export interface RpcRequestBase {
  requestId: string;
  type: Exclude<RpcType, 'NOTIFY'>;
}

export interface ExecRequest extends RpcRequestBase {
  type: 'EXEC';
  sql: string;
  params?: unknown[];
}

export interface QueryRequest extends RpcRequestBase {
  type: 'QUERY';
  sql: string;
  params?: unknown[];
}

export interface InitRequest extends RpcRequestBase {
  type: 'INIT';
  filename?: string;
  wasmUrl?: string;
}

export interface CloseRequest extends RpcRequestBase {
  type: 'CLOSE';
}

export interface CollectionEnsureRequest extends RpcRequestBase {
  type: 'collection_ensure';
  name: string;
}

export interface CollectionInsertRequest extends RpcRequestBase {
  type: 'collection_insert';
  name: string;
  docId: string;
  doc: Document;
}

export interface CollectionUpdateRequest extends RpcRequestBase {
  type: 'collection_update';
  name: string;
  docId: string;
  doc: Partial<Document>;
}

export interface CollectionDeleteRequest extends RpcRequestBase {
  type: 'collection_delete';
  name: string;
  docId: string;
}

export interface CollectionFindByIdRequest extends RpcRequestBase {
  type: 'collection_findById';
  name: string;
  docId: string;
}

export interface CollectionFindRequest extends RpcRequestBase {
  type: 'collection_find';
  name: string;
}

export interface ChangesetApplyRequest extends RpcRequestBase {
  type: 'changeset_apply';
  payload: unknown;
}

export type RpcRequest =
  | ExecRequest
  | QueryRequest
  | InitRequest
  | CloseRequest
  | CollectionEnsureRequest
  | CollectionInsertRequest
  | CollectionUpdateRequest
  | CollectionDeleteRequest
  | CollectionFindByIdRequest
  | CollectionFindRequest
  | ChangesetApplyRequest;

export interface RpcSuccess<T = unknown> {
  requestId: string;
  id?: string | number;
  ok: true;
  result: T;
}

export interface RpcError {
  requestId: string;
  id?: string | number;
  ok: false;
  error: string;
}

export type RpcResponse<T = unknown> = RpcSuccess<T> | RpcError;

export type CollectionChangeOp = 'insert' | 'update' | 'delete' | 'merge';

/** Unsolicited worker push (local mutations or remote changeset merges). */
export interface NotifyEvent<T extends Document = Document> {
  type: 'NOTIFY';
  collection: string;
  op: CollectionChangeOp;
  id: string;
  doc?: T;
}

export type NotifyHandler = (event: NotifyEvent) => void;

export type StatusHandler = (status: ConnectionStatus, detail?: string) => void;

export class SolebaseError extends Error {
  readonly code: string;
  readonly causeDetail?: unknown;

  constructor(message: string, code = 'SOLEBASE_ERROR', causeDetail?: unknown) {
    super(message);
    this.name = 'SolebaseError';
    this.code = code;
    this.causeDetail = causeDetail;
  }
}
