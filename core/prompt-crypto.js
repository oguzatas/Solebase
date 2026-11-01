/**
 * prompt-crypto.js — Client-side end-to-end encryption for Prompt2UI
 *
 * Uses Web Crypto API (AES-GCM + PBKDF2). All encryption happens in the
 * browser before any cloud adapter writes data. Passphrases never leave
 * the device.
 *
 * Encrypted envelope shape (JSON-serializable):
 * {
 *   v: 1,                    // format version
 *   salt: <base64>,          // PBKDF2 salt
 *   iv: <base64>,            // AES-GCM IV
 *   ciphertext: <base64>     // encrypted JSON payload
 * }
 */

const CRYPTO_VERSION = 1;
const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

/** Convert ArrayBuffer / TypedArray → base64 string */
function bufToB64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Convert base64 string → Uint8Array */
function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Derive an AES-GCM CryptoKey from a passphrase + salt via PBKDF2 */
async function deriveKey(passphrase, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
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
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt arbitrary JSON-serializable data with a passphrase.
 * @param {unknown} data - Plain object / array / primitive to encrypt
 * @param {string} passphrase - User passphrase (never stored)
 * @returns {Promise<object>} Encrypted envelope
 */
export async function encryptPayload(data, passphrase) {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('encryptPayload: passphrase is required');
  }
  if (!crypto?.subtle) {
    throw new Error('Web Crypto API unavailable (use HTTPS or localhost)');
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );

  return {
    v: CRYPTO_VERSION,
    salt: bufToB64(salt),
    iv: bufToB64(iv),
    ciphertext: bufToB64(ciphertext),
  };
}

/**
 * Decrypt an envelope produced by encryptPayload.
 * @param {object} encryptedData - Envelope with v/salt/iv/ciphertext
 * @param {string} passphrase - Same passphrase used to encrypt
 * @returns {Promise<unknown>} Original data
 */
export async function decryptPayload(encryptedData, passphrase) {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('decryptPayload: passphrase is required');
  }
  if (!encryptedData || typeof encryptedData !== 'object') {
    throw new Error('decryptPayload: invalid encrypted envelope');
  }
  if (!crypto?.subtle) {
    throw new Error('Web Crypto API unavailable (use HTTPS or localhost)');
  }

  const { salt, iv, ciphertext, v } = encryptedData;
  if (v !== CRYPTO_VERSION) {
    throw new Error(`Unsupported crypto format version: ${v}`);
  }
  if (!salt || !iv || !ciphertext) {
    throw new Error('decryptPayload: envelope missing salt/iv/ciphertext');
  }

  const key = await deriveKey(passphrase, b64ToBuf(salt));

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(iv) },
      key,
      b64ToBuf(ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('Decryption failed — wrong passphrase or corrupted data');
  }
}

/**
 * Quick check: does this look like a Prompt2UI encrypted envelope?
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEncryptedEnvelope(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.v === CRYPTO_VERSION &&
    typeof value.salt === 'string' &&
    typeof value.iv === 'string' &&
    typeof value.ciphertext === 'string'
  );
}
