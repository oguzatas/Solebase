/**
 * sync-p2p.js — WebRTC DataChannel transport for encrypted Solebase changesets
 *
 * Zero-backend by default: peers exchange SDP offer/answer out-of-band
 * (clipboard / QR / existing Share patterns). No signaling server is required.
 *
 * Temporary signaling assumption (documented):
 *   - Manual SDP JSON exchange (`createOffer` → share → `acceptOffer` →
 *     share answer → `acceptAnswer`), OR
 *   - Injected `signal` adapter `{ send(msg), onMessage(cb) }` if a future
 *     lightweight relay is available.
 *
 * Wire format on the data channel (JSON text frames):
 *   { v: 1, type: 'changeset', id, bytesB64 }   // encrypted package bytes
 *   { v: 1, type: 'ping'|'pong', id? }
 *
 * Always send *encrypted* packages — never plaintext changesets.
 */

import { bufToB64, b64ToBuf } from './sync-crypto.js';

export const P2P_WIRE_V = 1;

/**
 * @typedef {object} P2PSignalAdapter
 * @property {(msg: object) => void|Promise<void>} send
 * @property {(handler: (msg: object) => void) => () => void} onMessage
 */

/**
 * @typedef {object} P2PSessionOptions
 * @property {RTCConfiguration} [rtcConfig]
 * @property {P2PSignalAdapter|null} [signal]
 * @property {(pkgBytes: Uint8Array, meta: { id: string, peerId: string }) => void} [onChangeset]
 * @property {(state: string, detail?: string) => void} [onConnectionState]
 * @property {string} [label='solebase-sync']
 */

/**
 * One WebRTC peer connection that exchanges encrypted changeset blobs.
 */
export class SolebaseP2PSession {
  /**
   * @param {P2PSessionOptions} [options]
   */
  constructor(options = {}) {
    this.label = options.label || 'solebase-sync';
    this.peerId = randomId();
    this._onChangeset = options.onChangeset || (() => {});
    this._onConnectionState = options.onConnectionState || (() => {});
    this._signal = options.signal || null;
    this._unsubSignal = null;

    /** @type {RTCPeerConnection} */
    this.pc = new RTCPeerConnection(
      options.rtcConfig || {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      },
    );

    /** @type {RTCDataChannel|null} */
    this.channel = null;

    /** @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
    this._pending = new Map();

    this.pc.addEventListener('connectionstatechange', () => {
      this._onConnectionState(this.pc.connectionState);
    });

    this.pc.addEventListener('iceconnectionstatechange', () => {
      this._onConnectionState(`ice:${this.pc.iceConnectionState}`);
    });

    this.pc.addEventListener('datachannel', (event) => {
      this._bindChannel(event.channel);
    });

    if (this._signal) {
      this._unsubSignal = this._signal.onMessage((msg) => {
        void this._onSignalMessage(msg);
      });
    }
  }

  /** @returns {boolean} */
  get connected() {
    return this.channel != null && this.channel.readyState === 'open';
  }

  /**
   * Create an SDP offer (caller / initiator). Share the returned descriptor
   * with the remote peer via QR / clipboard.
   * @returns {Promise<{ type: 'offer', sdp: string, peerId: string }>}
   */
  async createOffer() {
    this.channel = this.pc.createDataChannel(this.label, { ordered: true });
    this._bindChannel(this.channel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await waitForIceGathering(this.pc);

    const desc = {
      type: 'offer',
      sdp: this.pc.localDescription?.sdp || '',
      peerId: this.peerId,
    };

    if (this._signal) {
      await this._signal.send({ kind: 'sdp', ...desc });
    }
    return desc;
  }

  /**
   * Accept a remote offer and produce an answer (callee).
   * @param {{ type: string, sdp: string, peerId?: string }} remoteOffer
   * @returns {Promise<{ type: 'answer', sdp: string, peerId: string }>}
   */
  async acceptOffer(remoteOffer) {
    if (!remoteOffer?.sdp) throw new Error('acceptOffer requires remote SDP');
    await this.pc.setRemoteDescription({
      type: 'offer',
      sdp: remoteOffer.sdp,
    });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitForIceGathering(this.pc);

    const desc = {
      type: 'answer',
      sdp: this.pc.localDescription?.sdp || '',
      peerId: this.peerId,
    };
    if (this._signal) {
      await this._signal.send({ kind: 'sdp', ...desc });
    }
    return desc;
  }

  /**
   * Apply the remote answer (initiator side).
   * @param {{ type: string, sdp: string, peerId?: string }} remoteAnswer
   */
  async acceptAnswer(remoteAnswer) {
    if (!remoteAnswer?.sdp) throw new Error('acceptAnswer requires remote SDP');
    await this.pc.setRemoteDescription({
      type: 'answer',
      sdp: remoteAnswer.sdp,
    });
  }

  /**
   * Send an already-encrypted ciphertext package (Uint8Array from packCiphertextPackage).
   * @param {Uint8Array} encryptedBytes
   * @param {string} [id]
   * @returns {Promise<{ id: string }>}
   */
  async sendEncryptedChangeset(encryptedBytes) {
    if (!(encryptedBytes instanceof Uint8Array)) {
      throw new Error('sendEncryptedChangeset requires Uint8Array');
    }
    await this._waitOpen();
    const id = randomId();
    const frame = {
      v: P2P_WIRE_V,
      type: 'changeset',
      id,
      bytesB64: bufToB64(encryptedBytes),
    };
    this.channel.send(JSON.stringify(frame));
    return { id };
  }

  /** @returns {Promise<void>} */
  async ping() {
    await this._waitOpen();
    const id = randomId();
    this.channel.send(JSON.stringify({ v: P2P_WIRE_V, type: 'ping', id }));
  }

  close() {
    if (this._unsubSignal) {
      try {
        this._unsubSignal();
      } catch {
        /* ignore */
      }
      this._unsubSignal = null;
    }
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
    this.channel = null;
  }

  /** @param {RTCDataChannel} channel */
  _bindChannel(channel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => {
      this._onConnectionState('channel-open');
    });
    channel.addEventListener('close', () => {
      this._onConnectionState('channel-close');
    });
    channel.addEventListener('error', () => {
      this._onConnectionState('channel-error');
    });
    channel.addEventListener('message', (event) => {
      this._onChannelMessage(event.data);
    });
  }

  /** @param {unknown} data */
  _onChannelMessage(data) {
    let text;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(data);
    } else if (ArrayBuffer.isView(data)) {
      text = new TextDecoder().decode(data);
    } else {
      return;
    }

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || msg.v !== P2P_WIRE_V) return;

    if (msg.type === 'ping') {
      try {
        this.channel?.send(JSON.stringify({ v: P2P_WIRE_V, type: 'pong', id: msg.id }));
      } catch {
        /* ignore */
      }
      return;
    }
    if (msg.type === 'pong') return;

    if (msg.type === 'changeset' && typeof msg.bytesB64 === 'string') {
      const bytes = b64ToBuf(msg.bytesB64);
      this._onChangeset(bytes, { id: String(msg.id || ''), peerId: this.peerId });
    }
  }

  /** @param {object} msg */
  async _onSignalMessage(msg) {
    if (!msg || msg.kind !== 'sdp') return;
    if (msg.type === 'offer' && this.pc.signalingState === 'stable') {
      const answer = await this.acceptOffer(msg);
      await this._signal?.send({ kind: 'sdp', ...answer });
    } else if (msg.type === 'answer' && this.pc.signalingState === 'have-local-offer') {
      await this.acceptAnswer(msg);
    }
  }

  /** @returns {Promise<void>} */
  _waitOpen() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 30_000;
      const tick = () => {
        if (this.connected) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error('P2P data channel did not open in time'));
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }
}

/**
 * Loopback helper for same-page / smoke tests: two peers connected via
 * in-memory signal + SDP exchange (still real RTCPeerConnection).
 *
 * @param {object} [options]
 * @param {(bytes: Uint8Array, meta: object) => void} [options.onA]
 * @param {(bytes: Uint8Array, meta: object) => void} [options.onB]
 * @returns {Promise<{ a: SolebaseP2PSession, b: SolebaseP2PSession, close: () => void }>}
 */
export async function connectP2PLoopback(options = {}) {
  const bus = createInMemorySignalBus();
  const a = new SolebaseP2PSession({
    signal: bus.endpoint('a'),
    onChangeset: options.onA,
  });
  const b = new SolebaseP2PSession({
    signal: bus.endpoint('b'),
    onChangeset: options.onB,
  });

  const offer = await a.createOffer();
  const answer = await b.acceptOffer(offer);
  await a.acceptAnswer(answer);

  await Promise.all([a._waitOpen(), b._waitOpen()]);

  return {
    a,
    b,
    close() {
      a.close();
      b.close();
    },
  };
}

/**
 * Encode / decode SDP descriptors for QR / clipboard (compact JSON).
 * @param {object} desc
 * @returns {string}
 */
export function encodeSignalPayload(desc) {
  return JSON.stringify(desc);
}

/** @param {string} text */
export function decodeSignalPayload(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed.sdp !== 'string') {
    throw new Error('invalid signal payload');
  }
  return parsed;
}

/**
 * Tiny in-memory pub/sub used for loopback smoke (and as a template for
 * temporary local relays). Not a network signaling server.
 */
export function createInMemorySignalBus() {
  /** @type {Map<string, Set<(msg: object) => void>>} */
  const listeners = new Map();

  return {
    /**
     * @param {string} id
     * @returns {P2PSignalAdapter}
     */
    endpoint(id) {
      if (!listeners.has(id)) listeners.set(id, new Set());
      return {
        async send(msg) {
          for (const [peerId, set] of listeners) {
            if (peerId === id) continue;
            for (const handler of set) handler({ ...msg, from: id });
          }
        },
        onMessage(handler) {
          listeners.get(id).add(handler);
          return () => listeners.get(id)?.delete(handler);
        },
      };
    },
  };
}

/** @param {RTCPeerConnection} pc */
function waitForIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    // Some browsers finish before the listener attaches.
    setTimeout(check, 0);
    setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }, 3000);
  });
}

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
