import crypto from "node:crypto";

// Encryption for secrets we must keep (Gmail refresh tokens).
// AES-256-GCM both hides the data and detects tampering.
// The key is 32 random bytes, base64-encoded, in the TOKEN_ENCRYPTION_KEY env var,
// so a leaked database dump alone can't be used to read anyone's email.

export type Sealed = { v: 1; iv: string; tag: string; data: string };

export function loadKey(b64: string | undefined): Buffer {
  if (!b64) throw new Error("TOKEN_ENCRYPTION_KEY is missing, check api/.env");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function seal(value: unknown, key: Buffer): Sealed {
  const iv = crypto.randomBytes(12); // fresh per message, never reused
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function isSealed(x: unknown): x is Sealed {
  return typeof x === "object" && x !== null && (x as Sealed).v === 1 && typeof (x as Sealed).data === "string";
}

// Throws if the key is wrong or the data was modified
export function unseal<T>(sealed: Sealed, key: Buffer): T {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const out = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]);
  return JSON.parse(out.toString("utf8")) as T;
}
