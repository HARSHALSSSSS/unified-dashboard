import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Application-level encryption for secrets at rest (marketplace refresh tokens, client secrets, ...).
 * AES-256-GCM with a random 96-bit nonce per message, key id embedded for rotation.
 * Envelope format (single string, safe for a text column):  v1.<keyId>.<iv>.<tag>.<ciphertext>   (base64url parts)
 *
 * Production upgrade path: replace the key source with a KMS data-key (AWS KMS / GCP KMS) behind this same interface.
 */
export interface KeyRing { activeKeyId: string; keys: Map<string, Buffer> }

export function parseKeyRing(spec: string): KeyRing {
  const keys = new Map<string, Buffer>();
  let active: string | undefined;
  for (const entry of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    if (idx < 1) throw new Error('ENCRYPTION_KEYS entries must look like keyId:base64Key');
    const id = entry.slice(0, idx);
    const buf = Buffer.from(entry.slice(idx + 1), 'base64');
    if (buf.length !== 32) throw new Error(`Encryption key "${id}" must decode to exactly 32 bytes`);
    keys.set(id, buf);
    active ??= id;
  }
  if (!active) throw new Error('ENCRYPTION_KEYS is empty');
  return { activeKeyId: active, keys };
}

export class SecretBox {
  constructor(private readonly ring: KeyRing) {}

  /** `aad` binds ciphertext to its context (e.g. `marketplace_authorizations:<vendorId>`): moving a blob to another row/tenant fails to decrypt. */
  encrypt(plaintext: string, aad: string): string {
    const key = this.ring.keys.get(this.ring.activeKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', this.ring.activeKeyId, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(envelope: string, aad: string): string {
    const [version, keyId, iv, tag, ct] = envelope.split('.');
    if (version !== 'v1' || !keyId || !iv || !tag || !ct) throw new Error('Unsupported ciphertext envelope');
    const key = this.ring.keys.get(keyId);
    if (!key) throw new Error(`Unknown encryption key id "${keyId}"`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad));
    const authTag = Buffer.from(tag, 'base64url');
    if (authTag.length !== 16) throw new Error('Invalid authentication tag'); // never accept a truncated GCM tag
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** True when the envelope was written with a non-active key (re-encrypt lazily on next write). */
  needsRotation(envelope: string): boolean {
    return envelope.split('.')[1] !== this.ring.activeKeyId;
  }
}

const boxes = new Map<string, SecretBox>();
/** Process-wide SecretBox for a key-ring spec (ENCRYPTION_KEYS). Memoised: parsing keys once per process. */
export function getSecretBox(keySpec: string): SecretBox {
  let box = boxes.get(keySpec);
  if (!box) {
    box = new SecretBox(parseKeyRing(keySpec));
    boxes.set(keySpec, box);
  }
  return box;
}
