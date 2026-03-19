/**
 * Web Crypto API Wrapper for E2EE
 * Implements Elliptic Curve Diffie-Hellman (ECDH) key exchange 
 * and AES-GCM encryption for high-speed secure media relay.
 */

// 1. Generate local Ephemeral Key Pair for the active session
export async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  return await window.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, // Private key must be extractable to be used for derivation
    ['deriveKey', 'deriveBits']
  );
}

// 2. Export public key to Base64 to send via Signaling Server
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const exported = await window.crypto.subtle.exportKey('raw', key);
  const buffer = new Uint8Array(exported);
  let binary = '';
  // Avoid Maximum Call Stack Size Exceeded for huge arrays, though raw key is small (65 bytes)
  for (let i = 0; i < buffer.byteLength; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary);
}

// 3. Import peer's Base64 public key received from Signaling Server
export async function importPublicKey(base64Key: string): Promise<CryptoKey> {
  const binaryString = atob(base64Key);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return await window.crypto.subtle.importKey(
    'raw',
    bytes.buffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

// 4. Multiply Private Key * Peer's Public Key -> Shared Secret (AES-GCM 256)
export async function deriveAESKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  return await window.crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    true, // Shared AES key must be extractable to be used in Web Workers
    ['encrypt', 'decrypt']
  );
}

// 5. Encrypt data with AES-GCM (auto-generates 12-byte IV nonce and prepends it)
export async function encryptData(sharedKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    sharedKey,
    data as Uint8Array // Type assertion to satisfy linter
  );
  
  // Pack as: [12 bytes IV] + [Ciphertext + AuthTag]
  const result = new Uint8Array(12 + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), 12);
  return result;
}

// 6. Decrypt data with AES-GCM (reads first 12 bytes as IV nonce)
export async function decryptData(sharedKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.subarray(0, 12);
  const ciphertext = data.subarray(12);
  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    sharedKey,
    ciphertext as Uint8Array // Type assertion to satisfy linter
  );
  return new Uint8Array(decrypted);
}
