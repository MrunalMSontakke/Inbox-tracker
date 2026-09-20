import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { loadKey, seal, unseal, isSealed } from "./secrets";

const key = loadKey(crypto.randomBytes(32).toString("base64"));
const tokens = { refresh_token: "1//secret-refresh", access_token: "ya29.secret", expiry_date: 123 };

test("sealed tokens round-trip and never contain the plain text", () => {
  const sealed = seal(tokens, key);
  assert.ok(isSealed(sealed));
  assert.ok(!JSON.stringify(sealed).includes("secret"));
  assert.deepEqual(unseal(sealed, key), tokens);
});

test("each seal uses a fresh IV", () => {
  assert.notEqual(seal(tokens, key).iv, seal(tokens, key).iv);
});

test("tampered data is rejected", () => {
  const sealed = seal(tokens, key);
  const bytes = Buffer.from(sealed.data, "base64");
  bytes[0] ^= 1;
  assert.throws(() => unseal({ ...sealed, data: bytes.toString("base64") }, key));
});

test("the wrong key is rejected", () => {
  const other = loadKey(crypto.randomBytes(32).toString("base64"));
  assert.throws(() => unseal(seal(tokens, key), other));
});

test("bad keys fail fast at startup", () => {
  assert.throws(() => loadKey(undefined));
  assert.throws(() => loadKey(Buffer.from("too short").toString("base64")));
});
