import { Collection } from './Collection.js';
import { WorkerBridge } from './WorkerBridge.js';
import type { ConnectionStatus, Document, SolebaseConfig, StatusHandler, SyncConfig } from './types.js';
export interface SolebaseInitInfo {
    filename: string;
    vfs: string;
    storage: string;
}
/** Minimal surface of core/sync-transport.js SolebaseSyncTransport. */
export interface SolebaseSyncHandle {
    start(): void;
    stop(): void;
    notifyLocalWrite(): void;
    syncNow(reason?: string): Promise<unknown>;
    status(): Promise<unknown>;
    createP2POffer(): Promise<{
        payload: string;
        offer: unknown;
    }>;
    acceptP2POffer(offer: string | object): Promise<{
        payload: string;
        answer: unknown;
    }>;
    acceptP2PAnswer(answer: string | object): Promise<{
        ok: boolean;
    }>;
    connectLoopbackForSmoke(): Promise<unknown>;
    pushLocal(): Promise<unknown>;
    pullRemote(): Promise<unknown>;
    applyEncryptedBytes(bytes: Uint8Array, meta?: object): Promise<unknown>;
    blobStore: unknown;
    pushCursor: number;
}
/**
 * Solebase Layer 1 — developer API.
 *
 *   const db = await Solebase.init({
 *     appId: 'notes',
 *     encryptionKey: '…',
 *     sync: { provider: 's3', options: { memory: true } },
 *   });
 *   const notes = db.collection('notes');
 *   await notes.insert({ title: 'Hello' });
 */
export declare class Solebase {
    readonly appId: string;
    readonly encryptionKey: string;
    readonly sync: SyncConfig | undefined;
    readonly bridge: WorkerBridge;
    private readonly collections;
    private closed;
    private syncTransport;
    private unsubNotifyForSync;
    private constructor();
    /**
     * Start the Layer 3 storage worker, handshake until WASM + OPFS are ready.
     * When `sync` is configured, starts P2P/blob transport (E2EE with encryptionKey).
     */
    static init(config: SolebaseConfig): Promise<Solebase>;
    /** Connection status of the storage worker bridge. */
    get status(): ConnectionStatus;
    onStatus(handler: StatusHandler): () => void;
    /**
     * Return a typed collection handle (cached per name).
     * Tables are ensured lazily on first mutation / query.
     */
    collection<T extends Document = Document>(name: string): Collection<T>;
    /** Encryption key for sync-crypto E2EE (do not log). */
    getEncryptionKey(): string;
    /** Sync config snapshot (Drive/S3 + options). */
    getSyncConfig(): SyncConfig | undefined;
    /** Active sync transport, or null when sync was not configured. */
    getSync(): SolebaseSyncHandle | null;
    /** Push/pull now (no-op result when sync disabled). */
    syncNow(reason?: string): Promise<unknown>;
    /**
     * Encrypt a payload with the configured encryptionKey via core/sync-crypto.
     */
    encryptForSync(payload: unknown): Promise<unknown>;
    close(): Promise<void>;
    /** @param {SyncConfig} syncConfig */
    private _startSync;
}
//# sourceMappingURL=Solebase.d.ts.map