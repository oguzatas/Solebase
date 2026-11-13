/**
 * S3SyncAdapter — Solebase Layer 2 zero-LIST cloud mailbox sync.
 *
 * Class B poll: GET/HEAD manifest.json with If-None-Match (304 → []).
 * Atomic push: PUT chunk → GET manifest → append → PUT with If-Match (412 retry).
 * Never calls ListObjectsV2 (eliminates S3/R2 Class A LIST).
 *
 * Compatible with Cloudflare R2, AWS S3, Backblaze B2, MinIO (path-style + forcePathStyle).
 */

import { signAwsV4 } from './sync-blob-store.js';
import {
  decryptChangeset,
  packCiphertextPackage,
  unpackCiphertextPackage,
} from './sync-crypto.js';
import type {
  S3SyncAdapterOptions,
  S3SyncPushMeta,
  SyncManifest,
  SyncManifestChunk,
} from './manifest.types.js';
import {
  S3SyncError,
  chunkAppliedKey,
  emptyManifest,
  isSyncManifest,
} from './manifest.types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETENTION_DAYS = 30;

export class S3SyncAdapter {
  readonly id = 's3-manifest';

  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly region: string;
  private readonly prefix: string;
  private readonly encryptionKey: string;
  private localSiteId: string;
  private readonly retentionDays: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly decryptFn: (
    pkgOrBytes: Uint8Array | object,
    key: string,
  ) => Promise<unknown>;

  /** Last seen ETag of manifest.json (quoted form as returned by S3). */
  private lastETag: string | null = null;
  /** In-memory applied set: `siteId:dbVersion` and/or chunk id. */
  private readonly applied = new Set<string>();

  constructor(options: S3SyncAdapterOptions) {
    this.endpoint = String(options.endpoint || '').replace(/\/$/, '');
    this.bucket = String(options.bucket || '');
    this.accessKeyId = String(options.accessKeyId || '');
    this.secretAccessKey = String(options.secretAccessKey || '');
    this.region = String(options.region || 'auto');
    this.prefix = String(options.prefix || '')
      .replace(/^\/+|\/+$/g, '');
    this.encryptionKey = String(options.encryptionKey || '');
    this.localSiteId = String(options.localSiteId || '');
    this.retentionDays =
      options.retentionDays === 0
        ? 0
        : Number(options.retentionDays ?? DEFAULT_RETENTION_DAYS);
    this.timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxRetries = Number(options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
    this.decryptFn =
      options.decrypt ||
      ((pkg, key) => decryptChangeset(pkg as Uint8Array, key));

    if (!this.endpoint || !this.bucket || !this.accessKeyId || !this.secretAccessKey) {
      throw new S3SyncError(
        'S3SyncAdapter requires endpoint, bucket, accessKeyId, secretAccessKey',
        'CONFIG',
      );
    }
    if (!this.prefix) {
      throw new S3SyncError('S3SyncAdapter requires a non-empty prefix (room namespace)', 'CONFIG');
    }
  }

  /** Manifest object key for this room. */
  manifestKey(): string {
    return `${this.prefix}/manifest.json`;
  }

  setLocalSiteId(siteId: string): void {
    this.localSiteId = String(siteId || '');
  }

  markApplied(siteId: string, dbVersion: number, chunkId?: string): void {
    this.applied.add(chunkAppliedKey(siteId, dbVersion));
    if (chunkId) this.applied.add(chunkId);
  }

  async status(): Promise<{ ok: boolean; label: string; detail?: string }> {
    return {
      ok: true,
      label: `S3 manifest → ${this.endpoint}/${this.bucket}/${this.manifestKey()}`,
      detail: `etag=${this.lastETag || 'none'} applied=${this.applied.size}`,
    };
  }

  /**
   * Class B poll. Uses If-None-Match against last seen ETag.
   * 304 → []. 200 → download unseen encrypted chunks, decrypt, return raw JSON buffers.
   */
  async pull(lastKnownDbVersion: number): Promise<Uint8Array[]> {
    const result = await this.getManifest({
      ifNoneMatch: this.lastETag || undefined,
    });

    if (result.status === 304) {
      return [];
    }
    if (result.status === 404 || !result.manifest) {
      this.lastETag = null;
      return [];
    }

    if (result.etag) this.lastETag = result.etag;

    const pending = result.manifest.chunks.filter((chunk) => {
      if (this.applied.has(chunk.id)) return false;
      if (this.applied.has(chunkAppliedKey(chunk.siteId, chunk.dbVersion))) return false;
      // Own site + already at/below local watermark → skip.
      if (
        this.localSiteId &&
        chunk.siteId === this.localSiteId &&
        chunk.dbVersion <= lastKnownDbVersion
      ) {
        return false;
      }
      return true;
    });

    if (!pending.length) return [];

    const encrypted = await Promise.all(
      pending.map(async (chunk) => {
        const bytes = await this.getObject(chunk.key);
        return { chunk, bytes };
      }),
    );

    /** @type {Uint8Array[]} */
    const out: Uint8Array[] = [];
    for (const { chunk, bytes } of encrypted) {
      if (!bytes) {
        this.markApplied(chunk.siteId, chunk.dbVersion, chunk.id);
        continue;
      }
      try {
        if (this.encryptionKey) {
          const payload = await this.decryptFn(bytes, this.encryptionKey);
          const raw =
            payload instanceof Uint8Array
              ? payload
              : new TextEncoder().encode(JSON.stringify(payload));
          out.push(raw);
        } else {
          // No key → return packed ciphertext for caller to decrypt.
          out.push(bytes);
        }
        this.markApplied(chunk.siteId, chunk.dbVersion, chunk.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/decryption failed|wrong key|passphrase|corrupted data/i.test(message)) {
          // Skip stale blobs; caller may surface aggregate failure.
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  /**
   * Atomic push with optimistic locking.
   * A: PUT chunk  B: GET manifest  C: append  D: PUT If-Match (412 → retry ≤5).
   */
  async push(encryptedChangeset: Uint8Array, meta: S3SyncPushMeta): Promise<void> {
    if (!(encryptedChangeset instanceof Uint8Array) && !ArrayBuffer.isView(encryptedChangeset)) {
      throw new S3SyncError('push requires Uint8Array encrypted changeset', 'CONFIG');
    }
    const siteId = String(meta?.siteId || '').trim();
    const dbVersion = Number(meta?.dbVersion);
    if (!siteId || !Number.isFinite(dbVersion)) {
      throw new S3SyncError('push meta requires siteId and numeric dbVersion', 'CONFIG');
    }

    const bytes =
      encryptedChangeset instanceof Uint8Array
        ? encryptedChangeset
        : new Uint8Array(
            (encryptedChangeset as ArrayBufferView).buffer,
            (encryptedChangeset as ArrayBufferView).byteOffset,
            (encryptedChangeset as ArrayBufferView).byteLength,
          );

    const now = Date.now();
    const chunkId = randomId();
    const safeSite = sanitize(siteId);
    const chunkKey = `${this.prefix}/chunks/${now}-${safeSite}.bin`;

    // A — upload blob first (idempotent key; safe to retry manifest only).
    await this.putObject(chunkKey, bytes, 'application/octet-stream');

    const chunk: SyncManifestChunk = {
      id: chunkId,
      key: chunkKey,
      siteId,
      dbVersion,
      size: bytes.byteLength,
      createdAt: now,
    };

    let attempt = 0;
    while (attempt < this.maxRetries) {
      attempt += 1;
      try {
        await this.appendChunkToManifest(chunk);
        this.markApplied(siteId, dbVersion, chunkId);
        return;
      } catch (err) {
        if (err instanceof S3SyncError && err.code === 'PRECONDITION_FAILED') {
          if (attempt >= this.maxRetries) {
            throw new S3SyncError(
              `manifest If-Match conflict after ${this.maxRetries} retries`,
              'RETRY_EXHAUSTED',
              412,
              err,
            );
          }
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
    }
  }

  /* ─── Manifest helpers ─────────────────────────────────────────────── */

  private async appendChunkToManifest(chunk: SyncManifestChunk): Promise<void> {
    const got = await this.getManifest({});
    let manifest: SyncManifest;
    let etag: string | null = got.etag;
    let creating = false;

    if (got.status === 404 || !got.manifest) {
      manifest = emptyManifest();
      creating = true;
      etag = null;
    } else {
      manifest = got.manifest;
    }

    // Re-append is idempotent by chunk.key (412 retry path).
    if (!manifest.chunks.some((c) => c.key === chunk.key || c.id === chunk.id)) {
      manifest.chunks.push(chunk);
    }
    manifest.version = Number(manifest.version || 0) + 1;
    manifest.updatedAt = Date.now();

    if (this.retentionDays > 0) {
      await this.gcManifest(manifest);
    }

    const body = new TextEncoder().encode(JSON.stringify(manifest));
    const extraHeaders: Record<string, string> = creating
      ? { 'if-none-match': '*' }
      : etag
        ? { 'if-match': etag }
        : {};

    const res = await this.signedFetch({
      method: 'PUT',
      key: this.manifestKey(),
      body,
      contentType: 'application/json',
      extraHeaders,
    });

    if (res.status === 412 || res.status === 409) {
      throw new S3SyncError('manifest precondition failed', 'PRECONDITION_FAILED', res.status);
    }
    if (!res.ok) {
      throw new S3SyncError(`manifest PUT failed: ${res.status}`, 'HTTP', res.status);
    }
    const newEtag = res.headers.get('etag');
    if (newEtag) this.lastETag = newEtag;
  }

  private async gcManifest(manifest: SyncManifest): Promise<void> {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    const keep: SyncManifestChunk[] = [];
    const drop: SyncManifestChunk[] = [];
    for (const chunk of manifest.chunks) {
      const created =
        typeof chunk.createdAt === 'number'
          ? chunk.createdAt
          : parseTimestampFromChunkKey(chunk.key);
      if (created != null && created < cutoff) drop.push(chunk);
      else keep.push(chunk);
    }
    manifest.chunks = keep;
    // Best-effort delete; failures must not block push.
    await Promise.all(
      drop.map((c) =>
        this.deleteObject(c.key).catch(() => {
          /* ignore */
        }),
      ),
    );
  }

  private async getManifest(opts: {
    ifNoneMatch?: string;
  }): Promise<{
    status: number;
    etag: string | null;
    manifest: SyncManifest | null;
  }> {
    const extraHeaders: Record<string, string> = {};
    if (opts.ifNoneMatch) extraHeaders['if-none-match'] = opts.ifNoneMatch;

    const res = await this.signedFetch({
      method: 'GET',
      key: this.manifestKey(),
      body: '',
      extraHeaders,
    });

    if (res.status === 304) {
      return { status: 304, etag: this.lastETag, manifest: null };
    }
    if (res.status === 404) {
      return { status: 404, etag: null, manifest: null };
    }
    if (!res.ok) {
      throw new S3SyncError(`manifest GET failed: ${res.status}`, 'HTTP', res.status);
    }

    const etag = res.headers.get('etag');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await res.text());
    } catch (err) {
      throw new S3SyncError('manifest.json is not valid JSON', 'MANIFEST_INVALID', 200, err);
    }
    if (!isSyncManifest(parsed)) {
      throw new S3SyncError('manifest.json has invalid schema', 'MANIFEST_INVALID', 200);
    }
    // Normalize chunks array entries lightly.
    parsed.chunks = (parsed.chunks || []).filter(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        typeof c.key === 'string' &&
        typeof c.siteId === 'string' &&
        typeof c.dbVersion === 'number',
    );
    return { status: 200, etag, manifest: parsed };
  }

  /* ─── Object I/O ───────────────────────────────────────────────────── */

  private objectUrl(key: string): string {
    return `${this.endpoint}/${this.bucket}/${key}`;
  }

  private async getObject(key: string): Promise<Uint8Array | null> {
    const res = await this.signedFetch({ method: 'GET', key, body: '' });
    if (res.status === 404) return null;
    if (!res.ok) throw new S3SyncError(`S3 GET failed: ${res.status}`, 'HTTP', res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async putObject(
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const body = new Uint8Array(bytes);
    const res = await this.signedFetch({
      method: 'PUT',
      key,
      body,
      contentType,
    });
    if (!res.ok) throw new S3SyncError(`S3 PUT failed: ${res.status}`, 'HTTP', res.status);
  }

  private async deleteObject(key: string): Promise<void> {
    const res = await this.signedFetch({ method: 'DELETE', key, body: '' });
    if (!res.ok && res.status !== 404) {
      throw new S3SyncError(`S3 DELETE failed: ${res.status}`, 'HTTP', res.status);
    }
  }

  private async signedFetch(opts: {
    method: string;
    key: string;
    body: string | Uint8Array;
    contentType?: string;
    extraHeaders?: Record<string, string>;
  }): Promise<Response> {
    const url = this.objectUrl(opts.key);
    const { headers } = await signAwsV4({
      method: opts.method,
      url,
      body: opts.body,
      contentType: opts.contentType,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
      extraHeaders: opts.extraHeaders,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: opts.method,
        headers,
        body:
          opts.method === 'GET' || opts.method === 'HEAD' || opts.method === 'DELETE'
            ? undefined
            : opts.body instanceof Uint8Array
              ? opts.body
              : opts.body,
        signal: controller.signal,
      });
      return res;
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
        throw new S3SyncError(`S3 request timed out after ${this.timeoutMs}ms`, 'TIMEOUT');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ─── helpers ────────────────────────────────────────────────────────── */

function sanitize(value: string): string {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'x';
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function backoffMs(attempt: number): number {
  const base = Math.min(8_000, 200 * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * base * 0.4);
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse `{prefix}/chunks/{timestamp}-{siteId}.bin` → timestamp ms. */
function parseTimestampFromChunkKey(key: string): number | null {
  const m = /\/chunks\/(\d+)-/.exec(key);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export {
  S3SyncError,
  emptyManifest,
  chunkAppliedKey,
  isSyncManifest,
  packCiphertextPackage,
  unpackCiphertextPackage,
};
export type {
  SyncManifest,
  SyncManifestChunk,
  S3SyncAdapterOptions,
  S3SyncPushMeta,
};
