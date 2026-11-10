import { Collection } from './Collection.js';
import { WorkerBridge } from './WorkerBridge.js';
import type { ConnectionStatus, Document, SolebaseConfig, StatusHandler, SyncConfig } from './types.js';
export interface SolebaseInitInfo {
    filename: string;
    vfs: string;
    storage: string;
}
/**
 * Solebase Layer 1 — developer API.
 *
 *   const db = await Solebase.init({ appId: 'notes', encryptionKey: '…' });
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
    private constructor();
    /**
     * Start the Layer 3 storage worker, handshake until WASM + OPFS are ready.
     * Holds encryptionKey for future sync crypto (sync provider is stubbed).
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
    /** Encryption key for future sync-crypto E2EE (do not log). */
    getEncryptionKey(): string;
    /** Stubbed sync config (Drive/S3) — not started by Layer 1. */
    getSyncConfig(): SyncConfig | undefined;
    /**
     * Encrypt a payload with the configured encryptionKey via core/sync-crypto.
     * Ready for future S3/Drive changeset uploads; Layer 1 does not upload yet.
     */
    encryptForSync(payload: unknown): Promise<unknown>;
    close(): Promise<void>;
}
//# sourceMappingURL=Solebase.d.ts.map