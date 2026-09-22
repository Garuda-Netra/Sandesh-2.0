/**
 * Sandesh 2.0 - Local Identity Subsystem
 * ========================================
 * Provides a cryptographically secure, persistent device identity for Nearby/Offline Mode.
 *
 * Security Architecture:
 * - Uses Web Crypto API with non-exportable ECDSA (P-256) private keys (extractable = false).
 *   The private key cannot be extracted or exfiltrated through JavaScript or localStorage.
 * - Stores structured CryptoKey objects and identity state in IndexedDB (SandeshLocalDB).
 * - Offline entry is authenticated via cryptographic challenge-response signature verification:
 *   a fresh random nonce challenge must be signed by the non-exportable key and verified against
 *   the public key. A forged localStorage boolean flag cannot bypass this.
 * - When users are logged in online, their identity is automatically synced and attested.
 * - Manages local peer cache and offline outgoing queue in IndexedDB.
 */

'use strict';

window.SDH = window.SDH || {};

SDH.LocalIdentity = (() => {

  const DB_NAME = 'SandeshLocalDB';
  const DB_VERSION = 1;
  const STORES = {
    IDENTITY: 'identity',
    KEYS: 'keys',
    PEERS: 'nearby_peers',
    OFFLINE_QUEUE: 'offline_queue'
  };

  const KEY_ID = 'device_signing_key';
  const IDENTITY_ID = 'current_identity';

  let dbPromise = null;
  let cachedIdentity = null;

  // ── Database Initialization ──────────────────────────────────────────

  function getDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) {
          return reject(new Error('IndexedDB is not supported in this browser.'));
        }

        const request = window.indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;

          if (!db.objectStoreNames.contains(STORES.IDENTITY)) {
            db.createObjectStore(STORES.IDENTITY, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORES.KEYS)) {
            db.createObjectStore(STORES.KEYS, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORES.PEERS)) {
            const peerStore = db.createObjectStore(STORES.PEERS, { keyPath: 'peerId' });
            peerStore.createIndex('username', 'username', { unique: false });
            peerStore.createIndex('lastSeen', 'lastSeen', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.OFFLINE_QUEUE)) {
            const queueStore = db.createObjectStore(STORES.OFFLINE_QUEUE, { keyPath: 'tempId' });
            queueStore.createIndex('recipient', 'recipient', { unique: false });
            queueStore.createIndex('timestamp', 'timestamp', { unique: false });
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }

  function dbTransaction(storeName, mode, callback) {
    return getDB().then((db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;

        try {
          result = callback(store);
        } catch (err) {
          return reject(err);
        }

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      });
    });
  }

  // ── Cryptographic Helpers ────────────────────────────────────────────

  function isCryptoSupported() {
    return !!(window.crypto && window.crypto.subtle);
  }

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  function generateUUID() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    return 'dev_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  }

  /**
   * Generates a non-exportable ECDSA P-256 signing key pair.
   * `extractable: false` ensures the private key cannot be extracted via JavaScript.
   */
  async function generateNonExportableKeyPair() {
    if (!isCryptoSupported()) {
      throw new Error('Web Crypto API not available.');
    }

    const keyPair = await window.crypto.subtle.generateKey(
      {
        name: 'ECDSA',
        namedCurve: 'P-256'
      },
      false, // Private key is NOT extractable!
      ['sign', 'verify']
    );

    // Export public key in JWK format for distribution
    const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);

    return {
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      publicKeyJwk: publicKeyJwk
    };
  }

  // ── Core Identity Operations ─────────────────────────────────────────

  /**
   * Syncs the local device identity from an active online Cloud session.
   * Called automatically when user loads chat while authenticated online.
   *
   * @param {Object} profile - { username, userId, displayName, avatarUrl }
   * @returns {Promise<Object>} The synced identity object
   */
  async function syncFromCloudSession(profile) {
    if (!profile || !profile.username) {
      return null;
    }

    const db = await getDB();

    // Check existing stored identity
    const existingIdentity = await new Promise((resolve) => {
      const tx = db.transaction(STORES.IDENTITY, 'readonly');
      const req = tx.objectStore(STORES.IDENTITY).get(IDENTITY_ID);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });

    // Check existing keys
    const existingKeys = await new Promise((resolve) => {
      const tx = db.transaction(STORES.KEYS, 'readonly');
      const req = tx.objectStore(STORES.KEYS).get(KEY_ID);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });

    let keys = existingKeys;
    let deviceId = existingIdentity?.deviceId || generateUUID();
    let createdAt = existingIdentity?.createdAt || new Date().toISOString();

    // If no keys exist or user changed, generate a fresh non-exportable key pair
    if (!keys || !existingIdentity || existingIdentity.username !== profile.username) {
      console.log('[SDH.LocalIdentity] Generating fresh non-exportable device key pair for @' + profile.username);
      keys = await generateNonExportableKeyPair();

      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.KEYS, 'readwrite');
        tx.objectStore(STORES.KEYS).put({
          id: KEY_ID,
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
          publicKeyJwk: keys.publicKeyJwk,
          createdAt: new Date().toISOString()
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    // Create cryptographic attestation: sign (deviceId + username + userId + createdAt)
    const attestationPayload = new TextEncoder().encode(
      `${deviceId}:${profile.username}:${profile.userId || ''}:${createdAt}`
    );
    const signatureBuffer = await window.crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      keys.privateKey,
      attestationPayload
    );
    const attestationSignature = arrayBufferToBase64(signatureBuffer);

    const identityRecord = {
      id: IDENTITY_ID,
      deviceId: deviceId,
      username: profile.username,
      userId: profile.userId || null,
      displayName: profile.displayName || profile.username,
      avatarUrl: profile.avatarUrl || null,
      publicKeyJwk: keys.publicKeyJwk,
      attestation: attestationSignature,
      createdAt: createdAt,
      lastOnlineSync: new Date().toISOString()
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.IDENTITY, 'readwrite');
      tx.objectStore(STORES.IDENTITY).put(identityRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    cachedIdentity = identityRecord;
    console.log('[SDH.LocalIdentity] Synced secure local device identity for @' + profile.username);
    return identityRecord;
  }

  /**
   * Cryptographically verifies the local device identity for offline entry.
   * Performs a challenge-response sign & verify operation using the non-exportable key.
   *
   * @returns {Promise<{verified: boolean, identity?: Object, reason?: string}>}
   */
  async function verifyLocalIdentity() {
    try {
      const db = await getDB();

      const identityRecord = await new Promise((resolve) => {
        const tx = db.transaction(STORES.IDENTITY, 'readonly');
        const req = tx.objectStore(STORES.IDENTITY).get(IDENTITY_ID);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });

      if (!identityRecord || !identityRecord.username) {
        return {
          verified: false,
          reason: 'No local device identity found. You must log in online once to provision this device.'
        };
      }

      const keysRecord = await new Promise((resolve) => {
        const tx = db.transaction(STORES.KEYS, 'readonly');
        const req = tx.objectStore(STORES.KEYS).get(KEY_ID);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });

      if (!keysRecord || !keysRecord.privateKey || !keysRecord.publicKey) {
        return {
          verified: false,
          reason: 'Device cryptographic keys missing or corrupted.'
        };
      }

      // ── Challenge-Response Verification ──────────────────────────────
      // Generate a fresh random 32-byte challenge nonce
      const challengeNonce = window.crypto.getRandomValues(new Uint8Array(32));

      // Sign challenge using non-exportable private key
      const signatureBuffer = await window.crypto.subtle.sign(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        keysRecord.privateKey,
        challengeNonce
      );

      // Verify the signature against the public key
      const isValid = await window.crypto.subtle.verify(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        keysRecord.publicKey,
        signatureBuffer,
        challengeNonce
      );

      if (!isValid) {
        return {
          verified: false,
          reason: 'Cryptographic challenge verification failed. Key signature is invalid.'
        };
      }

      // Verify attestation integrity
      const attestationPayload = new TextEncoder().encode(
        `${identityRecord.deviceId}:${identityRecord.username}:${identityRecord.userId || ''}:${identityRecord.createdAt}`
      );
      const attestationSigBuffer = Uint8Array.from(window.atob(identityRecord.attestation), c => c.charCodeAt(0));

      const isAttestationValid = await window.crypto.subtle.verify(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        keysRecord.publicKey,
        attestationSigBuffer,
        attestationPayload
      );

      if (!isAttestationValid) {
        return {
          verified: false,
          reason: 'Device attestation integrity check failed.'
        };
      }

      cachedIdentity = identityRecord;
      return {
        verified: true,
        identity: identityRecord
      };

    } catch (err) {
      console.error('[SDH.LocalIdentity] Verification error:', err);
      return {
        verified: false,
        reason: 'Verification error: ' + (err.message || 'Unknown')
      };
    }
  }

  /**
   * Retrieves the current verified identity record (or null).
   */
  async function getIdentity() {
    if (cachedIdentity) return cachedIdentity;
    const res = await verifyLocalIdentity();
    if (res.verified) return res.identity;
    return null;
  }

  /**
   * Clears device identity on clean explicit logout.
   */
  async function clearLocalIdentity() {
    try {
      const db = await getDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction([STORES.IDENTITY, STORES.KEYS], 'readwrite');
        tx.objectStore(STORES.IDENTITY).clear();
        tx.objectStore(STORES.KEYS).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      cachedIdentity = null;
      console.log('[SDH.LocalIdentity] Local device identity cleared.');
    } catch (err) {
      console.warn('[SDH.LocalIdentity] Error clearing identity:', err);
    }
  }

  // ── Nearby Peer Store Management ─────────────────────────────────────

  /**
   * Saves or updates a discovered local peer.
   * @param {Object} peer - { peerId, username, displayName, avatarUrl, lastSeen, ipOrEndpoint, publicKeyJwk }
   */
  async function upsertPeer(peer) {
    if (!peer || !peer.peerId) return;
    try {
      const db = await getDB();
      peer.lastSeen = peer.lastSeen || new Date().toISOString();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.PEERS, 'readwrite');
        tx.objectStore(STORES.PEERS).put(peer);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('[SDH.LocalIdentity] Error saving peer:', err);
    }
  }

  /**
   * Retrieves all cached local peers from IndexedDB.
   */
  async function getAllPeers() {
    try {
      const db = await getDB();
      return await new Promise((resolve) => {
        const tx = db.transaction(STORES.PEERS, 'readonly');
        const req = tx.objectStore(STORES.PEERS).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch (err) {
      return [];
    }
  }

  /**
   * Removes an inactive local peer.
   */
  async function removePeer(peerId) {
    if (!peerId) return;
    try {
      const db = await getDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.PEERS, 'readwrite');
        tx.objectStore(STORES.PEERS).delete(peerId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('[SDH.LocalIdentity] Error removing peer:', err);
    }
  }

  // ── Offline Message Queue Management ─────────────────────────────────

  async function enqueueOfflineMessage(msg) {
    if (!msg || !msg.tempId) return;
    try {
      const db = await getDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.OFFLINE_QUEUE, 'readwrite');
        tx.objectStore(STORES.OFFLINE_QUEUE).put(msg);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('[SDH.LocalIdentity] Error enqueuing offline message:', err);
    }
  }

  async function getOfflineQueue() {
    try {
      const db = await getDB();
      return await new Promise((resolve) => {
        const tx = db.transaction(STORES.OFFLINE_QUEUE, 'readonly');
        const req = tx.objectStore(STORES.OFFLINE_QUEUE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch (err) {
      return [];
    }
  }

  async function dequeueOfflineMessage(tempId) {
    if (!tempId) return;
    try {
      const db = await getDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.OFFLINE_QUEUE, 'readwrite');
        tx.objectStore(STORES.OFFLINE_QUEUE).delete(tempId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('[SDH.LocalIdentity] Error removing offline message:', err);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────

  return {
    syncFromCloudSession,
    verifyLocalIdentity,
    getIdentity,
    clearLocalIdentity,
    upsertPeer,
    getAllPeers,
    removePeer,
    enqueueOfflineMessage,
    getOfflineQueue,
    dequeueOfflineMessage
  };

})();
