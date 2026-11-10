/** Solebase Layer 1 shared types. */

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export type SyncProvider = 'drive' | 's3';

export interface SyncConfig {
  provider: SyncProvider;
  options?: Record<string, unknown>;
}

export interface SolebaseConfig {
  /** Logical app / database id (used for OPFS filename). */
  appId: string;
  /** Held for future E2EE sync (S3/Drive changesets). */
  encryptionKey: string;
  /** Optional async sync provider stub (stored; not started by Layer 1). */
  sync?: SyncConfig;
  /** Override module-worker URL (default: core/db-worker.js relative to importer). */
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
export type RpcType = 'EXEC' | 'QUERY' | 'NOTIFY' | 'INIT' | 'CLOSE' | CollectionRpcType;

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
  | CollectionFindRequest;

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

export type CollectionChangeOp = 'insert' | 'update' | 'delete';

/** Unsolicited worker push (local mutations or future remote merges). */
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
