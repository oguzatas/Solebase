import type { ConnectionStatus, NotifyHandler, RpcRequest, StatusHandler } from './types.js';
export interface WorkerBridgeOptions {
    workerUrl: string | URL;
    /** Called on connection status changes. */
    onStatus?: StatusHandler;
}
/**
 * Promise RPC over `postMessage` with `requestId` (crypto.randomUUID()).
 * Resolves/rejects per request with no races. Subscribes to unsolicited
 * worker NOTIFY events. Tracks connection status if the worker dies.
 */
export declare class WorkerBridge {
    readonly worker: Worker;
    private readonly pending;
    private readonly notifyHandlers;
    private readonly statusHandlers;
    private status;
    private closed;
    constructor(options: WorkerBridgeOptions);
    getConnectionStatus(): ConnectionStatus;
    onStatus(handler: StatusHandler): () => void;
    /** Subscribe to unsolicited NOTIFY / push events. */
    onNotify(handler: NotifyHandler): () => void;
    /**
     * Send a typed RPC request. Uses crypto.randomUUID() as requestId.
     * Maps Layer 1 types onto the Layer 3 worker protocol.
     */
    request<T = unknown>(type: RpcRequest['type'], payload?: Record<string, unknown>): Promise<T>;
    exec(sql: string, params?: unknown[]): Promise<{
        changes: number;
    }>;
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    terminate(): void;
    private onMessage;
    private failAll;
    setStatus(status: ConnectionStatus, detail?: string): void;
}
//# sourceMappingURL=WorkerBridge.d.ts.map