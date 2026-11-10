import type {
  ConnectionStatus,
  NotifyEvent,
  NotifyHandler,
  RpcRequest,
  RpcResponse,
  StatusHandler,
} from './types.js';
import { SolebaseError } from './types.js';

export interface WorkerBridgeOptions {
  workerUrl: string | URL;
  /** Called on connection status changes. */
  onStatus?: StatusHandler;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

/**
 * Promise RPC over `postMessage` with `requestId` (crypto.randomUUID()).
 * Resolves/rejects per request with no races. Subscribes to unsolicited
 * worker NOTIFY events. Tracks connection status if the worker dies.
 */
export class WorkerBridge {
  readonly worker: Worker;
  private readonly pending = new Map<string, Pending>();
  private readonly notifyHandlers = new Set<NotifyHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private status: ConnectionStatus = 'connecting';
  private closed = false;

  constructor(options: WorkerBridgeOptions) {
    if (options.onStatus) this.statusHandlers.add(options.onStatus);

    try {
      this.worker = new Worker(options.workerUrl, { type: 'module' });
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : String(err));
      throw new SolebaseError(
        `failed to start storage worker: ${err instanceof Error ? err.message : String(err)}`,
        'WORKER_START',
        err,
      );
    }

    this.worker.addEventListener('message', (event: MessageEvent) => {
      this.onMessage(event.data);
    });

    this.worker.addEventListener('error', (event: ErrorEvent) => {
      const message = event.message || 'storage worker crashed';
      this.failAll(new SolebaseError(message, 'WORKER_CRASH', event));
      this.setStatus('error', message);
    });

    this.worker.addEventListener('messageerror', () => {
      const message = 'storage worker message could not be deserialized';
      this.failAll(new SolebaseError(message, 'WORKER_MESSAGE_ERROR'));
      this.setStatus('error', message);
    });
  }

  getConnectionStatus(): ConnectionStatus {
    return this.status;
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  /** Subscribe to unsolicited NOTIFY / push events. */
  onNotify(handler: NotifyHandler): () => void {
    this.notifyHandlers.add(handler);
    return () => {
      this.notifyHandlers.delete(handler);
    };
  }

  /**
   * Send a typed RPC request. Uses crypto.randomUUID() as requestId.
   * Maps Layer 1 types onto the Layer 3 worker protocol.
   */
  async request<T = unknown>(
    type: RpcRequest['type'],
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.closed) {
      throw new SolebaseError('worker bridge is closed', 'BRIDGE_CLOSED');
    }

    const requestId = crypto.randomUUID();
    const workerType = mapToWorkerType(type);

    const message = {
      id: requestId,
      requestId,
      type: workerType,
      ...payload,
    };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.worker.postMessage(message);
      } catch (err) {
        this.pending.delete(requestId);
        reject(
          new SolebaseError(
            err instanceof Error ? err.message : String(err),
            'POSTMESSAGE_FAILED',
            err,
          ),
        );
      }
    });
  }

  async exec(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return this.request('EXEC', { sql, params });
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.request<T[]>('QUERY', { sql, params });
  }

  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new SolebaseError('worker bridge terminated', 'BRIDGE_TERMINATED'));
    this.worker.terminate();
    this.setStatus('disconnected');
  }

  private onMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, unknown>;

    if (msg.type === 'worker-ready') {
      // Boot ping — still connecting until INIT succeeds.
      return;
    }

    if (msg.type === 'NOTIFY') {
      const event = msg as unknown as NotifyEvent;
      for (const handler of this.notifyHandlers) {
        try {
          handler(event);
        } catch (err) {
          console.error('[WorkerBridge] NOTIFY handler error', err);
        }
      }
      return;
    }

    const requestId =
      (typeof msg.requestId === 'string' && msg.requestId) ||
      (typeof msg.id === 'string' && msg.id) ||
      (msg.id != null ? String(msg.id) : null);

    if (!requestId) return;

    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);

    const response = msg as unknown as RpcResponse;
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(
        new SolebaseError(response.error || 'storage worker error', 'RPC_ERROR'),
      );
    }
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  setStatus(status: ConnectionStatus, detail?: string): void {
    this.status = status;
    for (const handler of this.statusHandlers) {
      try {
        handler(status, detail);
      } catch (err) {
        console.error('[WorkerBridge] status handler error', err);
      }
    }
  }
}

/** Map Layer 1 RPC types onto worker message types. */
function mapToWorkerType(type: RpcRequest['type']): string {
  switch (type) {
    case 'INIT':
      return 'init';
    case 'CLOSE':
      return 'close';
    case 'EXEC':
      return 'EXEC';
    case 'QUERY':
      return 'QUERY';
    default:
      return type;
  }
}
