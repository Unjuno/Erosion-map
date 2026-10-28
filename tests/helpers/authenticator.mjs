import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import assert from "node:assert/strict";
const ORIGIN = "http://localhost:4173";
const hash = (data) => createHash("sha256").update(data).digest();
export const b64url = (data) => Buffer.from(data).toString("base64url");

function cborHeader(major, length) {
  if (!Number.isInteger(length) || length < 0) throw new RangeError("invalid CBOR length");
  if (length <= 23) return Buffer.from([major * 32 + length]);
  if (length < 256) return Buffer.from([major * 32 + 24, length]);
  if (length < 65536) return Buffer.from([major * 32 + 25, length >> 8, length & 255]);
  throw new RangeError("oversized test CBOR input");
}
function cborText(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([cborHeader(3, bytes.length), bytes]);
}
function cborBytes(value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([cborHeader(2, bytes.length), bytes]);
}
function cborMap(pairs) {
  const parts = [cborHeader(5, pairs.length)];
  for (const [key, value] of pairs) {
    parts.push(cborText(key), value);
  }
  return Buffer.concat(parts);
}
function uint32(number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(number);
  return buffer;
}
export function simulatedAuthenticator(rpID = "localhost") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  assert.equal(x.length, 32);
  assert.equal(y.length, 32);
  const idBytes = randomBytes(16);
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x, Buffer.from([0x22, 0x58, 0x20]), y,
  ]);
  const id = b64url(idBytes);
  return {
    id,
    register(challenge, origin = ORIGIN) {
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: "webauthn.create", challenge, origin, crossOrigin: false,
      }));
      const rpHash = hash(rpID);
      const authData = Buffer.concat([
        rpHash, Buffer.from([0x45]), uint32(0), Buffer.alloc(16),
        Buffer.from([0, idBytes.length]), idBytes, cose,
      ]);
      const attestationObject = cborMap([
        ["fmt", cborText("none")],
        ["attStmt", cborMap([])],
        ["authData", cborBytes(authData)],
      ]);
      return {
        id, rawId: id, type: "public-key",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          attestationObject: b64url(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    authenticate(challenge, userHandle, origin = ORIGIN, counter = 1) {
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: "webauthn.get", challenge, origin, crossOrigin: false,
      }));
      const authenticatorData = Buffer.concat([
        hash(rpID), Buffer.from([0x05]), uint32(counter),
      ]);
      const signedBytes = Buffer.concat([
        authenticatorData, hash(clientDataJSON),
      ]);
      return {
        id, rawId: id, type: "public-key",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authenticatorData),
          signature: b64url(sign("sha256", signedBytes, privateKey)),
          userHandle,
        },
        clientExtensionResults: {},
      };
    },
  };
}
