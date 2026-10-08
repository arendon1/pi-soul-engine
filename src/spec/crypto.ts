/**
 * Password-based encryption for .soul payloads.
 *
 * Byte-compatible with the reference implementation
 * (`src/soul_protocol/runtime/export/crypto.py`):
 *   envelope = salt(16) || nonce(12) || AES-256-GCM(ciphertext + tag(16))
 *   key = scrypt(password, salt, n=2^17, r=8, p=1, dkLen=32)
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;

export function deriveKey(password: string, salt: Buffer): Buffer {
	return scryptSync(Buffer.from(password, "utf8"), salt, KEY_LENGTH, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		maxmem: 256 * 1024 * 1024,
	});
}

export function encryptBlob(data: Uint8Array, password: string): Buffer {
	const salt = randomBytes(SALT_LENGTH);
	const nonce = randomBytes(NONCE_LENGTH);
	const key = deriveKey(password, salt);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([salt, nonce, ciphertext, tag]);
}

export function decryptBlob(encrypted: Uint8Array, password: string): Buffer {
	const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
	const minLength = SALT_LENGTH + NONCE_LENGTH + TAG_LENGTH;
	if (buf.length < minLength) {
		throw new Error("Encrypted data is too short to be valid");
	}
	const salt = buf.subarray(0, SALT_LENGTH);
	const nonce = buf.subarray(SALT_LENGTH, SALT_LENGTH + NONCE_LENGTH);
	const ciphertext = buf.subarray(SALT_LENGTH + NONCE_LENGTH);
	const key = deriveKey(password, salt);
	const decipher = createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LENGTH));
	try {
		return Buffer.concat([
			decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_LENGTH)),
			decipher.final(),
		]);
	} catch {
		throw new Error("Decryption failed — wrong password or corrupted data");
	}
}
