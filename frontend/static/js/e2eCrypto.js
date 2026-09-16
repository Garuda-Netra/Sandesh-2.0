/**
 * Sandesh 2.0 - End-to-End Encryption (E2EE) Module
 * 
 * Provides zero-dependency, real-time client-side encryption and decryption
 * for both 1-on-1 direct messages and Group chats using the Web Crypto API.
 * 
 * Cryptographic Specifications:
 * - Key Exchange: ECDH (Elliptic Curve Diffie-Hellman) over NIST P-256 curve
 * - Symmetric Encryption: AES-256-GCM with 96-bit (12-byte) random IV
 * - Group Key Exchange: Group Symmetric Key (AES-256-GCM) encrypted per-member via ECDH
 */

(function () {
  'use strict';

  window.SDH = window.SDH || {};

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  // In-memory key caches
  let currentUsername = null;
  let myPrivateKey = null;
  let myPublicKey = null;
  let myPublicKeyJwk = null;

  const peerPublicKeys = {};   // username -> JWK
  const sharedKeyCache = {};   // username -> CryptoKey (AES-GCM)
  const groupKeyCache = {};    // groupId  -> CryptoKey (AES-GCM)
  const groupRawCache = {};    // groupId  -> base64 string

  // ── Helper Utilities ───────────────────────────────────────────────────

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = window.atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function isCryptoSupported() {
    return !!(window.crypto && window.crypto.subtle);
  }

  function getCsrfToken() {
    if (window.SDH_DATA && window.SDH_DATA.csrfToken) {
      return window.SDH_DATA.csrfToken;
    }
    const cookie = document.cookie
      .split('; ')
      .find(row => row.startsWith('csrftoken='));
    return cookie ? cookie.split('=')[1] : '';
  }

  // ── Initialization & Key Generation ────────────────────────────────────

  /**
   * Initializes the E2EE subsystem for the currently logged-in user.
   * Loads existing ECDH key pair from localStorage or generates a fresh one.
   * Registers public key with the backend server.
   */
  async function init(username) {
    if (!isCryptoSupported()) {
      console.warn('[E2EE] Web Crypto API is not available in this environment.');
      return false;
    }

    if (!username) {
      username = window.SDH_DATA?.currentUser || '';
    }
    currentUsername = username;
    if (!currentUsername) return false;

    const privStorageKey = `sdh_e2e_priv_${currentUsername}`;
    const pubStorageKey = `sdh_e2e_pub_${currentUsername}`;

    const storedPriv = localStorage.getItem(privStorageKey);
    const storedPub = localStorage.getItem(pubStorageKey);

    if (storedPriv && storedPub) {
      try {
        const privJwk = JSON.parse(storedPriv);
        const pubJwk = JSON.parse(storedPub);

        myPrivateKey = await window.crypto.subtle.importKey(
          'jwk',
          privJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          ['deriveKey', 'deriveBits']
        );

        myPublicKey = await window.crypto.subtle.importKey(
          'jwk',
          pubJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          []
        );

        myPublicKeyJwk = pubJwk;
        peerPublicKeys[currentUsername] = pubJwk;
      } catch (err) {
        console.warn('[E2EE] Stored keys invalid, regenerating fresh key pair:', err);
        myPrivateKey = null;
        myPublicKey = null;
      }
    }

    // Generate fresh key pair if not loaded
    if (!myPrivateKey || !myPublicKey) {
      try {
        const keyPair = await window.crypto.subtle.generateKey(
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          ['deriveKey', 'deriveBits']
        );

        myPrivateKey = keyPair.privateKey;
        myPublicKey = keyPair.publicKey;

        const privJwk = await window.crypto.subtle.exportKey('jwk', myPrivateKey);
        const pubJwk = await window.crypto.subtle.exportKey('jwk', myPublicKey);

        myPublicKeyJwk = pubJwk;
        peerPublicKeys[currentUsername] = pubJwk;

        localStorage.setItem(privStorageKey, JSON.stringify(privJwk));
        localStorage.setItem(pubStorageKey, JSON.stringify(pubJwk));
        console.log('[E2EE] Generated and stored new ECDH P-256 key pair.');
      } catch (genErr) {
        console.error('[E2EE] Failed to generate ECDH key pair:', genErr);
        return false;
      }
    }

    // Publish public key to server in the background
    publishPublicKey(myPublicKeyJwk).catch(err => {
      console.warn('[E2EE] Error syncing public key to server:', err);
    });

    console.log(`[E2EE] End-to-End Encryption active for @${currentUsername}`);
    return true;
  }

  async function publishPublicKey(pubJwk) {
    if (!pubJwk) return;
    try {
      await fetch('/messaging/api/e2e/public-key/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': getCsrfToken()
        },
        body: JSON.stringify({ public_key: pubJwk })
      });
    } catch (err) {
      console.warn('[E2EE] Could not publish public key to server:', err);
    }
  }

  // ── Public Key Lookup & Shared Key Derivation ──────────────────────────

  async function getPeerPublicKey(username) {
    if (!username) return null;
    if (peerPublicKeys[username]) {
      return peerPublicKeys[username];
    }

    try {
      const res = await fetch(`/messaging/api/e2e/public-key/${encodeURIComponent(username)}/`);
      if (!res.ok) return null;
      const data = await res.json();
      if (data.public_key) {
        peerPublicKeys[username] = data.public_key;
        return data.public_key;
      }
    } catch (err) {
      console.warn(`[E2EE] Failed to fetch public key for ${username}:`, err);
    }
    return null;
  }

  async function deriveSharedKey(peerUsername, peerPubJwk) {
    if (!myPrivateKey) return null;
    if (sharedKeyCache[peerUsername]) {
      return sharedKeyCache[peerUsername];
    }

    try {
      const peerCryptoKey = await window.crypto.subtle.importKey(
        'jwk',
        peerPubJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );

      const aesKey = await window.crypto.subtle.deriveKey(
        { name: 'ECDH', public: peerCryptoKey },
        myPrivateKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      sharedKeyCache[peerUsername] = aesKey;
      return aesKey;
    } catch (err) {
      console.error(`[E2EE] Key derivation failed with ${peerUsername}:`, err);
      return null;
    }
  }

  // ── 1-on-1 Direct Message Encryption & Decryption ──────────────────────

  /**
   * Encrypts a text message for a direct conversation partner.
   */
  async function encrypt(plaintext, peerUsername) {
    if (!isCryptoSupported() || !plaintext || !myPrivateKey) {
      return { ciphertext: plaintext, iv: '', is_encrypted: false };
    }

    try {
      const peerPubJwk = await getPeerPublicKey(peerUsername);
      if (!peerPubJwk) {
        // Peer has not registered a key yet
        return { ciphertext: plaintext, iv: '', is_encrypted: false };
      }

      const aesKey = await deriveSharedKey(peerUsername, peerPubJwk);
      if (!aesKey) {
        return { ciphertext: plaintext, iv: '', is_encrypted: false };
      }

      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const encoded = textEncoder.encode(plaintext);

      const ciphertextBuffer = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        aesKey,
        encoded
      );

      return {
        ciphertext: arrayBufferToBase64(ciphertextBuffer),
        iv: arrayBufferToBase64(iv),
        is_encrypted: true
      };
    } catch (err) {
      console.error('[E2EE] Encryption error:', err);
      return { ciphertext: plaintext, iv: '', is_encrypted: false };
    }
  }

  /**
   * Decrypts a 1-on-1 text message.
   */
  async function decrypt(ciphertextB64, ivB64, peerUsername) {
    if (!ciphertextB64 || !ivB64) {
      return ciphertextB64 || '';
    }
    if (!isCryptoSupported() || !myPrivateKey) {
      return '🔒 [Encrypted message]';
    }

    try {
      const peerPubJwk = await getPeerPublicKey(peerUsername);
      if (!peerPubJwk) {
        return '🔒 [Encrypted message - Waiting for key]';
      }

      const aesKey = await deriveSharedKey(peerUsername, peerPubJwk);
      if (!aesKey) {
        return '🔒 [Encrypted message - Key derivation error]';
      }

      const iv = base64ToArrayBuffer(ivB64);
      const ciphertext = base64ToArrayBuffer(ciphertextB64);

      const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(iv) },
        aesKey,
        ciphertext
      );

      return textDecoder.decode(decryptedBuffer);
    } catch (err) {
      console.warn('[E2EE] Decryption failed for message from', peerUsername, err);
      return '🔒 [Encrypted message]';
    }
  }

  // ── Group Key Management & Group Encryption ───────────────────────────

  /**
   * Retrieves or initializes the AES-256 Group Key for a specific group.
   * If forceServerCheck is true, skips local caches and queries the server.
   */
  async function getGroupKey(groupId, forceServerCheck = false) {
    const gid = String(groupId);
    if (!forceServerCheck && groupKeyCache[gid]) {
      return groupKeyCache[gid];
    }

    const localStoreKey = `sdh_gk_${currentUsername}_${gid}`;
    const storedKeyB64 = localStorage.getItem(localStoreKey);

    if (!forceServerCheck && storedKeyB64) {
      try {
        const rawKeyBuffer = base64ToArrayBuffer(storedKeyB64);
        const groupCryptoKey = await window.crypto.subtle.importKey(
          'raw',
          rawKeyBuffer,
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
        groupKeyCache[gid] = groupCryptoKey;
        groupRawCache[gid] = storedKeyB64;
        return groupCryptoKey;
      } catch (err) {
        console.warn(`[E2EE] Failed to import cached group key for ${gid}:`, err);
      }
    }

    // Attempt to fetch our encrypted group key from server
    try {
      const res = await fetch(`/messaging/api/groups/${gid}/e2e-key/`);
      if (res.ok) {
        const data = await res.json();
        if (data.has_key && data.encrypted_key && data.encryption_iv) {
          // Decrypt the raw group key using sender's public key
          const senderUsername = data.sender_username;
          if (data.sender_public_key && senderUsername) {
            peerPublicKeys[senderUsername] = data.sender_public_key;
          }

          const decryptedRawB64 = await decrypt(
            data.encrypted_key,
            data.encryption_iv,
            senderUsername || currentUsername
          );

          if (decryptedRawB64 && !decryptedRawB64.startsWith('🔒')) {
            const rawKeyBuffer = base64ToArrayBuffer(decryptedRawB64);
            const groupCryptoKey = await window.crypto.subtle.importKey(
              'raw',
              rawKeyBuffer,
              { name: 'AES-GCM', length: 256 },
              true,
              ['encrypt', 'decrypt']
            );
            groupKeyCache[gid] = groupCryptoKey;
            groupRawCache[gid] = decryptedRawB64;
            localStorage.setItem(localStoreKey, decryptedRawB64);
            return groupCryptoKey;
          }
        }
      }
    } catch (fetchErr) {
      console.warn(`[E2EE] Could not fetch group key for ${gid}:`, fetchErr);
    }

    // Check if any other member has a key on the server before generating a new one
    try {
      const membersRes = await fetch(`/messaging/api/groups/${gid}/e2e-member-keys/`);
      if (membersRes.ok) {
        const membersData = await membersRes.json();
        const existingKeys = (membersData.members || []).some(m => m.has_group_key);
        if (existingKeys) {
          // A group key already exists among group members; avoid generating a divergent key.
          console.log(`[E2EE] Group key exists for group ${gid}, waiting for key sync.`);
          return null;
        }
      }
    } catch (checkErr) {
      console.warn(`[E2EE] Could not verify existing group keys:`, checkErr);
    }

    // No existing key on server: brand new group. Generate fresh AES-256 group key
    try {
      const rawKeyBytes = window.crypto.getRandomValues(new Uint8Array(32)); // 256-bit
      const rawB64 = arrayBufferToBase64(rawKeyBytes);

      const groupCryptoKey = await window.crypto.subtle.importKey(
        'raw',
        rawKeyBytes,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );

      groupKeyCache[gid] = groupCryptoKey;
      groupRawCache[gid] = rawB64;
      localStorage.setItem(localStoreKey, rawB64);

      // Distribute encrypted group key to all members who have public keys
      distributeGroupKey(gid, rawB64, true).catch(err => {
        console.warn(`[E2EE] Initial group key distribution error for ${gid}:`, err);
      });

      return groupCryptoKey;
    } catch (genErr) {
      console.error(`[E2EE] Group key generation failed for ${gid}:`, genErr);
      return null;
    }
  }

  /**
   * Encrypts the raw group key for each group member and uploads to server.
   */
  async function distributeGroupKey(groupId, rawKeyB64, forceUploadAll = false) {
    const gid = String(groupId);
    if (!rawKeyB64) {
      rawKeyB64 = groupRawCache[gid] || localStorage.getItem(`sdh_gk_${currentUsername}_${gid}`);
    }
    if (!rawKeyB64) return;

    try {
      const res = await fetch(`/messaging/api/groups/${gid}/e2e-member-keys/`);
      if (!res.ok) return;
      const data = await res.json();
      const members = data.members || [];

      const keysToUpload = [];

      for (const member of members) {
        // Skip members who already have the key unless forceUploadAll is set
        if (!forceUploadAll && member.has_group_key && member.username !== currentUsername) continue;

        let pubKey = member.public_key;
        if (!pubKey && member.username === currentUsername) {
          pubKey = myPublicKeyJwk;
        }
        if (!pubKey) continue;

        peerPublicKeys[member.username] = pubKey;
        const enc = await encrypt(rawKeyB64, member.username);
        if (enc.is_encrypted) {
          keysToUpload.push({
            user_id: member.user_id,
            encrypted_key: enc.ciphertext,
            encryption_iv: enc.iv
          });
        }
      }

      if (keysToUpload.length > 0) {
        await fetch(`/messaging/api/groups/${gid}/e2e-keys/`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRFToken': getCsrfToken()
          },
          body: JSON.stringify({ keys: keysToUpload })
        });
        console.log(`[E2EE] Distributed encrypted group keys to ${keysToUpload.length} members for group ${gid}`);
      }
    } catch (distErr) {
      console.warn(`[E2EE] distributeGroupKey error for ${gid}:`, distErr);
    }
  }

  /**
   * Syncs group keys to any members who don't have one yet.
   */
  async function ensureGroupKeyDistributed(groupId) {
    const gid = String(groupId);
    const rawB64 = groupRawCache[gid] || localStorage.getItem(`sdh_gk_${currentUsername}_${gid}`);
    if (rawB64) {
      await distributeGroupKey(gid, rawB64, false);
    } else {
      await getGroupKey(gid);
    }
  }

  /**
   * Encrypts a text message for a group chat.
   */
  async function encryptGroupMessage(plaintext, groupId) {
    if (!isCryptoSupported() || !plaintext) {
      return { ciphertext: plaintext, iv: '', is_encrypted: false };
    }

    try {
      const groupKey = await getGroupKey(groupId);
      if (!groupKey) {
        return { ciphertext: plaintext, iv: '', is_encrypted: false };
      }

      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const encoded = textEncoder.encode(plaintext);

      const ciphertextBuffer = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        groupKey,
        encoded
      );

      return {
        ciphertext: arrayBufferToBase64(ciphertextBuffer),
        iv: arrayBufferToBase64(iv),
        is_encrypted: true
      };
    } catch (err) {
      console.error(`[E2EE] Group encryption error for group ${groupId}:`, err);
      return { ciphertext: plaintext, iv: '', is_encrypted: false };
    }
  }

  /**
   * Decrypts a group message with auto-retry and key refresh.
   */
  async function decryptGroupMessage(ciphertextB64, ivB64, groupId) {
    if (!ciphertextB64 || !ivB64) {
      return ciphertextB64 || '';
    }
    if (!isCryptoSupported()) {
      return '🔒 [Encrypted group message]';
    }

    const gid = String(groupId);
    try {
      let groupKey = await getGroupKey(gid);
      if (!groupKey) {
        // Attempt a fresh fetch from server once
        groupKey = await getGroupKey(gid, true);
        if (!groupKey) {
          return '🔒 [Encrypted group message - Missing key]';
        }
      }

      const iv = base64ToArrayBuffer(ivB64);
      const ciphertext = base64ToArrayBuffer(ciphertextB64);

      try {
        const decryptedBuffer = await window.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: new Uint8Array(iv) },
          groupKey,
          ciphertext
        );
        return textDecoder.decode(decryptedBuffer);
      } catch (decErr) {
        // Tag mismatch or wrong key: force re-fetch latest group key from server and retry once
        delete groupKeyCache[gid];
        delete groupRawCache[gid];
        localStorage.removeItem(`sdh_gk_${currentUsername}_${gid}`);
        const freshKey = await getGroupKey(gid, true);
        if (freshKey) {
          const retryBuffer = await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(iv) },
            freshKey,
            ciphertext
          );
          return textDecoder.decode(retryBuffer);
        }
        throw decErr;
      }
    } catch (err) {
      console.warn(`[E2EE] Group decryption failed for group ${groupId}:`, err);
      return '🔒 [Encrypted group message]';
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  window.SDH.E2E = {
    init,
    isCryptoSupported,
    getPeerPublicKey,
    encrypt,
    decrypt,
    getGroupKey,
    distributeGroupKey,
    ensureGroupKeyDistributed,
    encryptGroupMessage,
    decryptGroupMessage,
  };

})();
