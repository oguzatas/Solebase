/**
 * manifest.types.js — Solebase zero-LIST sync manifest helpers (JS runtime).
 * Types live in manifest.types.ts.
 */

/**
 * @typedef {object} SyncManifestChunk
 * @property {string} id
 * @property {string} key
 * @property {string} siteId
 * @property {number} dbVersion
 * @property {number} size
 * @property {number} [createdAt]
 */

/**
 * @typedef {object} SyncManifest
 * @property {number} version
 * @property {number} updatedAt
 * @property {SyncManifestChunk[]} chunks
 */

/**
 * @typedef {'TIMEOUT'|'NOT_MODIFIED'|'NOT_FOUND'|'PRECONDITION_FAILED'|'HTTP'|'MANIFEST_INVALID'|'CONFIG'|'RETRY_EXHAUSTED'} S3SyncErrorCode
 */

export class S3SyncError extends Error {
  /**
   * @param {string} message
   * @param {S3SyncErrorCode} code
   * @param {number} [status]
   * @param {unknown} [causeDetail]
   */
  constructor(message, code, status, causeDetail) {
    super(message);
    this.name = 'S3SyncError';
    this.code = code;
    this.status = status;
    this.causeDetail = causeDetail;
  }
}

/** @param {number} [now] @returns {SyncManifest} */
export function emptyManifest(now = Date.now()) {
  return { version: 0, updatedAt: now, chunks: [] };
}

/** @param {string} siteId @param {number} dbVersion */
export function chunkAppliedKey(siteId, dbVersion) {
  return `${siteId}:${dbVersion}`;
}

/** @param {unknown} value @returns {value is SyncManifest} */
export function isSyncManifest(value) {
  if (!value || typeof value !== 'object') return false;
  const m = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof m.version === 'number' &&
    typeof m.updatedAt === 'number' &&
    Array.isArray(m.chunks)
  );
}
