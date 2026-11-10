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
export class Solebase {
  readonly appId: string;
  readonly encryptionKey: string;
  readonly sync: SyncConfig | undefined;
  readonly bridge: WorkerBridge;

  private readonly collections = new Map<string, Collection<Document>>();
  private closed = false;

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
   * Holds encryptionKey for future sync crypto (sync provider is stubbed).
   */
  static async init(config: SolebaseConfig): Promise<Solebase> {
    validateConfig(config);

    const workerUrl = resolveWorkerUrl(config.workerUrl);
    const bridge = new WorkerBridge({ workerUrl });
    bridge.setStatus('connecting');

    const filename = opfsFilename(config.appId);

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
      // encryptionKey retained for future E2EE via core/sync-crypto.js;
      // sync provider is stubbed (not started by Layer 1).
      return new Solebase(config, bridge);
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

  /** Encryption key for future sync-crypto E2EE (do not log). */
  getEncryptionKey(): string {
    return this.encryptionKey;
  }

  /** Stubbed sync config (Drive/S3) — not started by Layer 1. */
  getSyncConfig(): SyncConfig | undefined {
    return this.sync ? { ...this.sync, options: { ...this.sync.options } } : undefined;
  }

  /**
   * Encrypt a payload with the configured encryptionKey via core/sync-crypto.
   * Ready for future S3/Drive changeset uploads; Layer 1 does not upload yet.
   */
  async encryptForSync(payload: unknown): Promise<unknown> {
    const url = new URL('../../../core/sync-crypto.js', import.meta.url).href;
    const mod = (await import(/* @vite-ignore */ url)) as {
      encryptChangeset: (data: unknown, key: string) => Promise<unknown>;
    };
    return mod.encryptChangeset(payload, this.encryptionKey);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.bridge.request('CLOSE');
    } catch {
      /* ignore close races */
    }
    this.bridge.terminate();
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

function resolveWorkerUrl(workerUrl?: string | URL): URL {
  if (workerUrl instanceof URL) return workerUrl;
  if (typeof workerUrl === 'string' && workerUrl.length > 0) {
    return new URL(workerUrl, globalThis.location?.href ?? import.meta.url);
  }
  return DEFAULT_WORKER_PATH;
}
