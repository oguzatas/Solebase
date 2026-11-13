/**
 * Solebase Layer 2 — zero-LIST sync manifest types.
 *
 * One index per room/namespace at `{prefix}/manifest.json`.
 * Poll via ETag (If-None-Match → 304). Push via If-Match optimistic locking.
 * Compatible with Cloudflare R2, AWS S3, Backblaze B2, and MinIO (path-style).
 */

/** One encrypted changeset blob referenced by the room manifest. */
export interface SyncManifestChunk {
  /** Stable id (uuid) for dedupe / applied tracking. */
  id: string;
  /** Object key, e.g. `{prefix}/chunks/{timestamp}-{siteId}.bin` */
  key: string;
  /** cr-sqlite site id (base64 or sanitized path form). */
  siteId: string;
  /** Local db_version / cursor when this chunk was produced. */
  dbVersion: number;
  /** Ciphertext byte length. */
  size: number;
  /** Epoch ms when the chunk was uploaded (optional; used for GC). */
  createdAt?: number;
}

/** Single JSON index for a room — never ListObjects. */
export interface SyncManifest {
  /** Monotonic manifest revision (increment on every successful append). */
  version: number;
  /** Epoch ms of last successful manifest write. */
  updatedAt: number;
  chunks: SyncManifestChunk[];
}

/** Meta attached to an already-encrypted push. */
export interface S3SyncPushMeta {
  siteId: string;
  dbVersion: number;
}

/** Constructor options for {@link S3SyncAdapter}. */
export interface S3SyncAdapterOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** AWS region or `auto` for R2. */
  region?: string;
  /**
   * Room/namespace prefix (no leading/trailing slash).
   * Manifest lives at `{prefix}/manifest.json`.
   */
  prefix: string;
  /**
   * E2EE passphrase / key for pull decrypt (sync-crypto).
   * When set, `pull()` returns plaintext JSON changeset buffers.
   * When omitted, `pull()` returns packed ciphertext packages.
   */
  encryptionKey?: string;
  /** Local site id — own pushed chunks are marked applied and skipped on pull. */
  localSiteId?: string;
  /** Prune chunks older than this many days during push (default 30; `0` disables). */
  retentionDays?: number;
  /** Per-request timeout ms (default 30_000). */
  timeoutMs?: number;
  /** Max If-Match conflict retries on push (default 5). */
  maxRetries?: number;
  /** Inject fetch (tests / Node). */
  fetch?: typeof globalThis.fetch;
  /**
   * Optional decrypt hook. Defaults to `decryptChangeset` from sync-crypto.js
   * when `encryptionKey` is set.
   */
  decrypt?: (pkgOrBytes: Uint8Array | object, key: string) => Promise<unknown>;
}

/** Error codes surfaced by the adapter (message always human-readable). */
export type S3SyncErrorCode =
  | 'TIMEOUT'
  | 'NOT_MODIFIED'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'HTTP'
  | 'MANIFEST_INVALID'
  | 'CONFIG'
  | 'RETRY_EXHAUSTED';

export class S3SyncError extends Error {
  readonly code: S3SyncErrorCode;
  readonly status?: number;
  readonly causeDetail?: unknown;

  constructor(
    message: string,
    code: S3SyncErrorCode,
    status?: number,
    causeDetail?: unknown,
  ) {
    super(message);
    this.name = 'S3SyncError';
    this.code = code;
    this.status = status;
    this.causeDetail = causeDetail;
  }
}

export function emptyManifest(now = Date.now()): SyncManifest {
  return { version: 0, updatedAt: now, chunks: [] };
}

export function chunkAppliedKey(siteId: string, dbVersion: number): string {
  return `${siteId}:${dbVersion}`;
}

export function isSyncManifest(value: unknown): value is SyncManifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.version === 'number' &&
    typeof m.updatedAt === 'number' &&
    Array.isArray(m.chunks)
  );
}
