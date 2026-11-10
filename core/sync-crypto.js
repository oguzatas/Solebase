/**
 * sync-crypto.js — E2EE for sync changesets (Web Crypto AES-GCM + PBKDF2)
 *
 * Encrypts changeset payloads in the browser before any future S3/Drive write.
 * Passphrases never leave the device. Accepts a passphrase string OR a CryptoKey.
 *
 * Package shape (JSON-serializable; also packable to Uint8Array via pack/unpack):
 * {
 *   v: 1,
 *   kdf: 'pbkdf2' | 'raw-key',
 *   salt?: <base64>,          // PBKDF2 only
 *   iv: <base64>,
 *   ciphertext: <base64>,
 *   encoding: 'json' | 'bytes'
 * }
 */

const CRYPTO_VERSION = 1;
const PBKDF2_ITERATIONS = 210_000; // match prompt-crypto.js
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

/** @param {ArrayBuffer|ArrayBufferView} buf */
export function bufToB64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** @param {string} b64 */
export function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @returns {Promise<CryptoKey>}
 */
async function deriveKeyFromPassphrase(passphrase, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * @param {string|CryptoKey} passphraseOrKey
 * @param {Uint8Array|null} salt
 * @returns {Promise<{ key: CryptoKey, kdf: 'pbkdf2'|'raw-key', salt: Uint8Array|null }>}
 */
async function resolveKey(passphraseOrKey, salt) {
  if (passphraseOrKey && typeof passphraseOrKey === 'object' && passphraseOrKey instanceof CryptoKey) {
    return { key: passphraseOrKey, kdf: 'raw-key', salt: null };
  }
  if (typeof passphraseOrKey !== 'string' || !passphraseOrKey) {
    throw new Error('passphraseOrKey must be a non-empty string or CryptoKey');
  }
  if (!salt) {
    throw new Error('PBKDF2 requires a salt');
  }
  const key = await deriveKeyFromPassphrase(passphraseOrKey, salt);
  return { key, kdf: 'pbkdf2', salt };
}

/**
 * @param {Uint8Array|ArrayBuffer|string|object} plaintext
 * @returns {{ bytes: Uint8Array, encoding: 'json'|'bytes' }}
 */
function toPlaintextBytes(plaintext) {
  if (typeof plaintext === 'string') {
    return { bytes: new TextEncoder().encode(plaintext), encoding: 'json' };
  }
  if (plaintext instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(plaintext), encoding: 'bytes' };
  }
  if (ArrayBuffer.isView(plaintext)) {
    return {
      bytes: new Uint8Array(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength),
      encoding: 'bytes',
    };
  }
  // JSON-serializable object/array/primitive
  return {
    bytes: new TextEncoder().encode(JSON.stringify(plaintext)),
    encoding: 'json',
  };
}

/**
 * Encrypt a changeset (JSON object/array, string, or raw bytes).
 * @param {Uint8Array|ArrayBuffer|string|object} plaintextBytesOrJson
 * @param {string|CryptoKey} passphraseOrKey
 * @returns {Promise<object>} Ciphertext package (structured object for blobs later)
 */
export async function encryptChangeset(plaintextBytesOrJson, passphraseOrKey) {
  if (!crypto?.subtle) {
    throw new Error('Web Crypto API unavailable (use HTTPS or localhost)');
  }

  const { bytes, encoding } = toPlaintextBytes(plaintextBytesOrJson);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const isKey = passphraseOrKey instanceof CryptoKey;
  const salt = isKey ? null : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const { key, kdf } = await resolveKey(passphraseOrKey, salt);

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);

  /** @type {Record<string, unknown>} */
  const pkg = {
    v: CRYPTO_VERSION,
    kdf,
    iv: bufToB64(iv),
    ciphertext: bufToB64(ciphertext),
    encoding,
  };
  if (salt) pkg.salt = bufToB64(salt);
  return pkg;
}

/**
 * Decrypt a package from encryptChangeset.
 * @param {object|Uint8Array} pkgOrBytes - Structured package or packed Uint8Array
 * @param {string|CryptoKey} passphraseOrKey
 * @returns {Promise<object|Uint8Array>} Original JSON (default) or raw bytes when encoding==='bytes'
 */
export async function decryptChangeset(pkgOrBytes, passphraseOrKey) {
  if (!crypto?.subtle) {
    throw new Error('Web Crypto API unavailable (use HTTPS or localhost)');
  }

  const pkg = pkgOrBytes instanceof Uint8Array || ArrayBuffer.isView(pkgOrBytes)
    ? unpackCiphertextPackage(pkgOrBytes)
    : pkgOrBytes;

  if (!pkg || typeof pkg !== 'object') {
    throw new Error('decryptChangeset: invalid ciphertext package');
  }
  if (pkg.v !== CRYPTO_VERSION) {
    throw new Error(`Unsupported crypto format version: ${pkg.v}`);
  }
  if (!pkg.iv || !pkg.ciphertext) {
    throw new Error('decryptChangeset: package missing iv/ciphertext');
  }

  const salt = pkg.salt ? b64ToBuf(pkg.salt) : null;
  if (pkg.kdf === 'pbkdf2' || (!pkg.kdf && salt)) {
    if (!(typeof passphraseOrKey === 'string' && passphraseOrKey)) {
      throw new Error('decryptChangeset: passphrase required for PBKDF2 package');
    }
    if (!salt) throw new Error('decryptChangeset: package missing salt');
  } else if (pkg.kdf === 'raw-key') {
    if (!(passphraseOrKey instanceof CryptoKey)) {
      throw new Error('decryptChangeset: CryptoKey required for raw-key package');
    }
  }

  let key;
  if (passphraseOrKey instanceof CryptoKey) {
    key = passphraseOrKey;
  } else {
    if (!salt) throw new Error('decryptChangeset: package missing salt');
    ({ key } = await resolveKey(passphraseOrKey, salt));
  }

  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(pkg.iv) },
      key,
      b64ToBuf(pkg.ciphertext),
    );
  } catch {
    // Never log plaintext or key material.
    throw new Error('Decryption failed — wrong key/passphrase or corrupted data');
  }

  const bytes = new Uint8Array(plaintext);
  if (pkg.encoding === 'bytes') return bytes;
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Pack a structured ciphertext package into a single Uint8Array (UTF-8 JSON).
 * Suitable for S3/Drive blob uploads later.
 * @param {object} pkg
 * @returns {Uint8Array}
 */
export function packCiphertextPackage(pkg) {
  return new TextEncoder().encode(JSON.stringify(pkg));
}

/**
 * @param {Uint8Array|ArrayBufferView} bytes
 * @returns {object}
 */
export function unpackCiphertextPackage(bytes) {
  const view = bytes instanceof Uint8Array
    ? bytes
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return JSON.parse(new TextDecoder().decode(view));
}

/**
 * Derive an exportable AES-GCM CryptoKey from a passphrase (for callers that want to cache a key).
 * @param {string} passphrase
 * @param {Uint8Array} [salt]
 * @returns {Promise<{ key: CryptoKey, salt: Uint8Array }>}
 */
export async function deriveChangesetKey(passphrase, salt) {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('deriveChangesetKey: passphrase is required');
  }
  const usedSalt = salt || crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKeyFromPassphrase(passphrase, usedSalt);
  return { key, salt: usedSalt };
}

export const SYNC_CRYPTO = Object.freeze({
  version: CRYPTO_VERSION,
  pbkdf2Iterations: PBKDF2_ITERATIONS,
  saltBytes: SALT_BYTES,
  ivBytes: IV_BYTES,
  keyBits: KEY_BITS,
});
