import { Collection } from './Collection.js';
import { WorkerBridge } from './WorkerBridge.js';
import type {
  ConnectionStatus,
  Document,
  SolebaseConfig,
  StatusHandler,
  SyncConfig,
} from './types.js';
import { SolebaseError } from './types.js';

const DEFAULT_WORKER_PATH = new URL('../../../core/db-worker.js', import.meta.url);
const SYNC_TRANSPORT_URL = new URL('../../../core/sync-transport.js', import.meta.url);
const SYNC_CRYPTO_URL = new URL('../../../core/sync-crypto.js', import.meta.url);

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
  createP2POffer(): Promise<{ payload: string; offer: unknown }>;
  acceptP2POffer(offer: string | object): Promise<{ payload: string; answer: unknown }>;
  acceptP2PAnswer(answer: string | object): Promise<{ ok: boolean }>;
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
export class Solebase {
  readonly appId: string;
  readonly encryptionKey: string;
  readonly sync: SyncConfig | undefined;
  readonly bridge: WorkerBridge;

  private readonly collections = new Map<string, Collection<Document>>();
  private closed = false;
  private syncTransport: SolebaseSyncHandle | null = null;
  private unsubNotifyForSync: (() => void) | null = null;

  private constructor(config: SolebaseConfig, bridge: WorkerBridge) {
    this.appId = config.appId;
    this.encryptionKey = config.encryptionKey;
    this.sync = config.sync
      ? { ...config.sync, options: { ...config.sync.options } }
      : undefined;
    this.bridge = bridge;
  }

  /**
   * Start the Layer 3 storage worker, handshake until WASM + OPFS are ready.
   * When `sync` is configured, starts P2P/blob transport (E2EE with encryptionKey).
   */
  static async init(config: SolebaseConfig): Promise<Solebase> {
    validateConfig(config);

    const workerUrl = resolveWorkerUrl(config.workerUrl);
    const bridge = new WorkerBridge({ workerUrl });
    bridge.setStatus('connecting');

    const filename = resolveFilename(config);

    try {
      const info = await bridge.request<SolebaseInitInfo>('INIT', {
        filename,
        wasmUrl: config.wasmUrl,
      });

      if (!info || info.storage !== 'opfs') {
        throw new SolebaseError(
          `expected OPFS storage, got ${JSON.stringify(info)}`,
          'INIT_BAD_STORAGE',
        );
      }

      bridge.setStatus('connected');
      const instance = new Solebase(config, bridge);
      if (config.sync) {
        await instance._startSync(config.sync);
      }
      return instance;
    } catch (err) {
      bridge.setStatus(
        'error',
        err instanceof Error ? err.message : String(err),
      );
      bridge.terminate();
      if (err instanceof SolebaseError) throw err;
      throw new SolebaseError(
        err instanceof Error ? err.message : String(err),
        'INIT_FAILED',
        err,
      );
    }
  }

  /** Connection status of the storage worker bridge. */
  get status(): ConnectionStatus {
    return this.bridge.getConnectionStatus();
  }

  onStatus(handler: StatusHandler): () => void {
    return this.bridge.onStatus(handler);
  }

  /**
   * Return a typed collection handle (cached per name).
   * Tables are ensured lazily on first mutation / query.
   */
  collection<T extends Document = Document>(name: string): Collection<T> {
    if (this.closed) {
      throw new SolebaseError('Solebase instance is closed', 'CLOSED');
    }
    const existing = this.collections.get(name);
    if (existing) {
      return existing as unknown as Collection<T>;
    }
    const col = new Collection<T>(this.bridge, name);
    this.collections.set(name, col as unknown as Collection<Document>);
    return col;
  }

  /** Encryption key for sync-crypto E2EE (do not log). */
  getEncryptionKey(): string {
    return this.encryptionKey;
  }

  /** Sync config snapshot (Drive/S3 + options). */
  getSyncConfig(): SyncConfig | undefined {
    return this.sync ? { ...this.sync, options: { ...this.sync.options } } : undefined;
  }

  /** Active sync transport, or null when sync was not configured. */
  getSync(): SolebaseSyncHandle | null {
    return this.syncTransport;
  }

  /** Push/pull now (no-op result when sync disabled). */
  async syncNow(reason = 'manual'): Promise<unknown> {
    if (!this.syncTransport) {
      return { ok: false, error: 'sync not configured' };
    }
    return this.syncTransport.syncNow(reason);
  }

  /**
   * Encrypt a payload with the configured encryptionKey via core/sync-crypto.
   */
  async encryptForSync(payload: unknown): Promise<unknown> {
    const mod = (await import(/* @vite-ignore */ SYNC_CRYPTO_URL.href)) as {
      encryptChangeset: (data: unknown, key: string) => Promise<unknown>;
    };
    return mod.encryptChangeset(payload, this.encryptionKey);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.unsubNotifyForSync) {
      this.unsubNotifyForSync();
      this.unsubNotifyForSync = null;
    }
    this.syncTransport?.stop();
    this.syncTransport = null;
    try {
      await this.bridge.request('CLOSE');
    } catch {
      /* ignore close races */
    }
    this.bridge.terminate();
  }

  /** @param {SyncConfig} syncConfig */
  private async _startSync(syncConfig: SyncConfig): Promise<void> {
    const mod = (await import(/* @vite-ignore */ SYNC_TRANSPORT_URL.href)) as {
      createSyncTransport: (opts: Record<string, unknown>) => SolebaseSyncHandle;
      bridgeAsSyncDb: (bridge: WorkerBridge) => unknown;
    };

    const transport = mod.createSyncTransport({
      appId: this.appId,
      encryptionKey: this.encryptionKey,
      provider: syncConfig.provider,
      options: {
        memory: false,
        ...syncConfig.options,
        // Enable P2P session scaffolding when options.p2p is truthy.
        p2p: Boolean(syncConfig.options?.p2p),
      },
      db: mod.bridgeAsSyncDb(this.bridge),
    });

    this.syncTransport = transport;

    // After local collection mutations, debounce a push/pull cycle.
    this.unsubNotifyForSync = this.bridge.onNotify((event) => {
      if (event.op === 'merge') return; // ignore echoes from remote apply
      transport.notifyLocalWrite();
    });

    transport.start();
  }
}

function validateConfig(config: SolebaseConfig): void {
  if (!config || typeof config !== 'object') {
    throw new SolebaseError('Solebase.init requires a config object', 'INVALID_CONFIG');
  }
  if (typeof config.appId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(config.appId)) {
    throw new SolebaseError(
      'appId must match /^[A-Za-z][A-Za-z0-9_-]{0,63}$/',
      'INVALID_APP_ID',
    );
  }
  if (typeof config.encryptionKey !== 'string' || config.encryptionKey.length === 0) {
    throw new SolebaseError('encryptionKey must be a non-empty string', 'INVALID_KEY');
  }
  if (config.sync) {
    if (config.sync.provider !== 'drive' && config.sync.provider !== 's3') {
      throw new SolebaseError(
        'sync.provider must be "drive" or "s3"',
        'INVALID_SYNC',
      );
    }
  }
}

function opfsFilename(appId: string): string {
  return `solebase-${appId}.db`;
}

function resolveFilename(config: SolebaseConfig): string {
  if (typeof config.filename === 'string' && config.filename.length > 0) {
    if (!/^[A-Za-z0-9._-]+$/.test(config.filename)) {
      throw new SolebaseError(
        'filename must match /^[A-Za-z0-9._-]+$/',
        'INVALID_FILENAME',
      );
    }
    return config.filename;
  }
  return opfsFilename(config.appId);
}

function resolveWorkerUrl(workerUrl?: string | URL): URL {
  if (workerUrl instanceof URL) return workerUrl;
  if (typeof workerUrl === 'string' && workerUrl.length > 0) {
    return new URL(workerUrl, globalThis.location?.href ?? import.meta.url);
  }
  return DEFAULT_WORKER_PATH;
}
