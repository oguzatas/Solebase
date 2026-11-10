/**
 * @solebase/core — Layer 1 Developer API
 *
 * Vanilla TypeScript. Apps talk only to Solebase / Collection —
 * never OPFS, cr-sqlite, or the worker directly.
 */

export { Solebase } from './Solebase.js';
export type { SolebaseInitInfo } from './Solebase.js';
export { Collection } from './Collection.js';
export type { CollectionSubscriber } from './Collection.js';
export { WorkerBridge } from './WorkerBridge.js';
export type { WorkerBridgeOptions } from './WorkerBridge.js';
export {
  SolebaseError,
  type ConnectionStatus,
  type SyncProvider,
  type SyncConfig,
  type SolebaseConfig,
  type Document,
  type RpcType,
  type RpcRequest,
  type RpcSuccess,
  type RpcError,
  type RpcResponse,
  type NotifyEvent,
  type NotifyHandler,
  type StatusHandler,
  type CollectionChangeOp,
} from './types.js';
