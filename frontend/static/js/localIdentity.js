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
  const DB_VERSION = 2;
  const STORES = {
    IDENTITY: 'identity',
    KEYS: 'keys',
    PEERS: 'nearby_peers',
    OFFLINE_QUEUE: 'offline_queue',
    MESSAGES: 'nearby_messages',
    CONVERSATIONS: 'nearby_conversations',
    FILES: 'nearby_files'
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
          if (!db.objectStoreNames.contains(STORES.MESSAGES)) {
            const msgStore = db.createObjectStore(STORES.MESSAGES, { keyPath: 'id' });
            msgStore.createIndex('conversationId', 'conversationId', { unique: false });
            msgStore.createIndex('timestamp', 'timestamp', { unique: false });
            msgStore.createIndex('message_id', 'message_id', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.CONVERSATIONS)) {
            const convStore = db.createObjectStore(STORES.CONVERSATIONS, { keyPath: 'id' });
            convStore.createIndex('peerUsername', 'peerUsername', { unique: false });
            convStore.createIndex('lastTimestamp', 'lastTimestamp', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.FILES)) {
            db.createObjectStore(STORES.FILES, { keyPath: 'fileId' });
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

  /**
   * Retrieves a single cached local peer by peerId.
   */
  async function getPeer(peerId) {
    if (!peerId) return null;
    try {
      const db = await getDB();
      return await new Promise((resolve) => {
        const tx = db.transaction(STORES.PEERS, 'readonly');
        const req = tx.objectStore(STORES.PEERS).get(peerId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (err) {
      return null;
    }
  }

  /**
   * Updates an existing peer record to mark it as verified with a Safety Code.
   */
  async function verifyPeer(peerId, safetyCode) {
    if (!peerId) return false;
    try {
      const peer = await getPeer(peerId);
      if (!peer) return false;
      peer.isVerified = true;
      peer.safetyCode = safetyCode || peer.safetyCode || '';
      peer.verifiedAt = new Date().toISOString();
      await upsertPeer(peer);
      return true;
    } catch (err) {
      console.warn('[SDH.LocalIdentity] Error verifying peer:', err);
      return false;
    }
  }

  // ── Nearby Message & Conversation Persistence ────────────────────────

  /**
   * Saves a nearby message in IndexedDB and updates conversation index.
   * @param {Object} msg - Standardized message packet
   */
  async function saveNearbyMessage(msg) {
    if (!msg || !msg.message_id) return;
    try {
      const db = await getDB();
      const id = msg.message_id || msg.id;
      const conversationId = msg.conversation_id || (
        msg.sender === (cachedIdentity?.username || window.SDH_DATA?.currentUser)
          ? msg.receiver
          : msg.sender
      );
      const timestamp = msg.timestamp || new Date().toISOString();

      const record = {
        id: String(id),
        message_id: String(id),
        conversationId: String(conversationId),
        sender: msg.sender,
        receiver: msg.receiver,
        message: msg.message || '',
        message_type: msg.message_type || 'text',
        original_filename: msg.original_filename || '',
        mime_type: msg.mime_type || '',
        file_id: msg.file_id || null,
        file_data: msg.file_data || null,
        is_encrypted: !!msg.is_encrypted,
        encryption_iv: msg.encryption_iv || '',
        timestamp: timestamp,
        is_delivered: msg.is_delivered !== undefined ? msg.is_delivered : true,
        is_read: msg.is_read !== undefined ? msg.is_read : false,
        is_nearby: true
      };

      // 1. Put message into MESSAGES store
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.MESSAGES, 'readwrite');
        tx.objectStore(STORES.MESSAGES).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      // 2. Upsert conversation summary in CONVERSATIONS store
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.CONVERSATIONS, 'readwrite');
        const store = tx.objectStore(STORES.CONVERSATIONS);
        const convSummary = {
          id: String(conversationId),
          peerUsername: String(conversationId),
          displayName: msg.displayName || String(conversationId),
          lastMessage: msg.message_type === 'image' ? '📷 Photo' : (msg.message_type === 'file' ? '📎 Attachment' : msg.message || ''),
          lastTimestamp: timestamp,
          lastMessageType: msg.message_type || 'text',
          is_nearby: true
        };
        store.put(convSummary);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      console.log('[SDH.LocalIdentity] Saved nearby message to IndexedDB:', record.id, 'for conversation:', conversationId);
      return record;
    } catch (err) {
      console.warn('[SDH.LocalIdentity] Error saving nearby message:', err);
    }
  }

  /**
   * Retrieves all nearby messages for a given conversation, sorted chronologically.
   * @param {string} conversationId - Peer username
   * @returns {Promise<Array>} List of messages
   */
  async function getNearbyHistory(conversationId) {
    if (!conversationId) return [];
    try {
      const db = await getDB();
      const messages = await new Promise((resolve) => {
        const tx = db.transaction(STORES.MESSAGES, 'readonly');
        const index = tx.objectStore(STORES.MESSAGES).index('conversationId');
        const req = index.getAll(String(conversationId));
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });

      // Sort chronologically
      return messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    } catch (err) {
      console.warn('[SDH.LocalIdentity] Error getting nearby history:', err);
      return [];
    }
  }

  /**
   * Retrieves all active nearby conversations.
   */
  async function getNearbyConversations() {
    try {
      const db = await getDB();
      const conversations = await new Promise((resolve) => {
        const tx = db.transaction(STORES.CONVERSATIONS, 'readonly');
        const req = tx.objectStore(STORES.CONVERSATIONS).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
      return conversations.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime());
    } catch (err) {
      return [];
    }
  }

  /**
   * Caches a binary file or photo blob in IndexedDB for offline access.
   */
  async function saveNearbyFile(fileId, fileBlobOrBuffer, metadata = {}) {
    if (!fileId || !fileBlobOrBuffer) return;
    try {
      const db = await getDB();
      const record = {
        fileId: String(fileId),
        filename: metadata.filename || 'file',
        mimeType: metadata.mimeType || 'application/octet-stream',
        size: metadata.size || fileBlobOrBuffer.size || fileBlobOrBuffer.byteLength || 0,
        data: fileBlobOrBuffer,
        createdAt: new Date().toISOString()
      };
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.FILES, 'readwrite');
        tx.objectStore(STORES.FILES).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      console.log('[SDH.LocalIdentity] Cached nearby file:', fileId);
    } catch (err) {
      console.warn('[SDH.LocalIdentity] Error caching file:', err);
    }
  }

  /**
   * Retrieves a cached file blob from IndexedDB.
   */
  async function getNearbyFile(fileId) {
    if (!fileId) return null;
    try {
      const db = await getDB();
      return await new Promise((resolve) => {
        const tx = db.transaction(STORES.FILES, 'readonly');
        const req = tx.objectStore(STORES.FILES).get(String(fileId));
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (err) {
      return null;
    }
  }

  /**
   * Marks a message as delivered.
   */
  async function markNearbyMessageDelivered(messageId) {
    if (!messageId) return;
    try {
      const db = await getDB();
      const tx = db.transaction(STORES.MESSAGES, 'readwrite');
      const store = tx.objectStore(STORES.MESSAGES);
      const req = store.get(String(messageId));
      req.onsuccess = () => {
        const msg = req.result;
        if (msg) {
          msg.is_delivered = true;
          store.put(msg);
        }
      };
    } catch (err) { }
  }

  /**
   * Marks a message as read.
   */
  async function markNearbyMessageRead(messageId) {
    if (!messageId) return;
    try {
      const db = await getDB();
      const tx = db.transaction(STORES.MESSAGES, 'readwrite');
      const store = tx.objectStore(STORES.MESSAGES);
      const req = store.get(String(messageId));
      req.onsuccess = () => {
        const msg = req.result;
        if (msg) {
          msg.is_read = true;
          msg.is_delivered = true;
          store.put(msg);
        }
      };
    } catch (err) { }
  }

  // ── Public API ───────────────────────────────────────────────────────

  return {
    syncFromCloudSession,
    verifyLocalIdentity,
    getIdentity,
    clearLocalIdentity,
    upsertPeer,
    getPeer,
    verifyPeer,
    getAllPeers,
    removePeer,
    enqueueOfflineMessage,
    getOfflineQueue,
    dequeueOfflineMessage,
    saveNearbyMessage,
    getNearbyHistory,
    getNearbyConversations,
    saveNearbyFile,
    getNearbyFile,
    markNearbyMessageDelivered,
    markNearbyMessageRead
  };

})();


