import type { WorkerBridge } from './WorkerBridge.js';
import type { Document } from './types.js';
export type CollectionSubscriber<T extends Document> = (docs: T[]) => void;
/**
 * Typed document collection backed by a Layer 3 CRR JSON table (`sb_<name>`).
 * Mutations go through WorkerBridge → db-worker (never main-thread SQLite).
 */
export declare class Collection<T extends Document = Document> {
    readonly name: string;
    private readonly bridge;
    private readonly subscribers;
    private ensured;
    private cache;
    private unsubNotify;
    constructor(bridge: WorkerBridge, name: string);
    private ensure;
    private onNotify;
    private emit;
    insert(doc: Omit<T, 'id'> & {
        id?: string;
    }): Promise<T>;
    update(id: string, patch: Partial<Omit<T, 'id'>>): Promise<T>;
    delete(id: string): Promise<void>;
    findById(id: string): Promise<T | null>;
    /**
     * Return all documents, optionally filtered by shallow equality on fields.
     * Filter runs in memory after QUERY (fine for hobby-scale collections).
     */
    find(filter?: Partial<T>): Promise<T[]>;
    /**
     * Subscribe to collection snapshots. Emits immediately (async fetch) and
     * again on local / remote NOTIFY changes. Returns unsubscribe.
     */
    subscribe(cb: CollectionSubscriber<T>): () => void;
}
//# sourceMappingURL=Collection.d.ts.map