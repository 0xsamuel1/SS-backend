/**
 * Structural validation of IPFS content identifiers (issue #781).
 *
 * Accepted encodings:
 * - CIDv1, base58btc multibase (`z...`)
 * - CIDv1, base32 lowercase multibase (`b...`, e.g. `bafy...`) — the default
 *   encoding for CIDv1 in current IPFS tooling
 * - CIDv0 (`Qm...`, base58btc sha2-256 multihash)
 *
 * Beyond the alphabet/prefix pattern, the decoded bytes must form a valid CID:
 * version byte, codec varint and a multihash whose declared digest length
 * matches exactly, so truncated or padded strings are rejected.
 */

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

const CID_V0_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1_BASE58_PATTERN = /^z[1-9A-HJ-NP-Za-km-z]{40,120}$/;
const CID_V1_BASE32_PATTERN = /^b[a-z2-7]{50,120}$/;

const MAX_DIGEST_LENGTH = 128;

function decodeBase58(input: string): Uint8Array | null {
  const bytes: number[] = []; // little-endian accumulator
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value < 0) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading '1' encodes one leading zero byte.
  for (const char of input) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function decodeBase32(input: string): Uint8Array | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of input) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  // Unpadded RFC 4648: leftover bits must be zero padding.
  if (bits >= 5 || (buffer & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

/** Reads an unsigned LEB128 varint; returns [value, nextOffset] or null. */
function readVarint(bytes: Uint8Array, offset: number): [number, number] | null {
  let value = 0;
  let shift = 0;
  for (let i = offset; i < bytes.length && shift <= 28; i++) {
    value |= (bytes[i] & 0x7f) << shift;
    if ((bytes[i] & 0x80) === 0) return [value >>> 0, i + 1];
    shift += 7;
  }
  return null;
}

/** Validates `<hash-code varint><digest-length varint><digest>` ending exactly at the buffer end. */
function isValidMultihash(bytes: Uint8Array, offset: number): boolean {
  const code = readVarint(bytes, offset);
  if (!code) return false;
  const length = readVarint(bytes, code[1]);
  if (!length) return false;
  const [digestLength, digestStart] = length;
  if (digestLength === 0 || digestLength > MAX_DIGEST_LENGTH) return false;
  return digestStart + digestLength === bytes.length;
}

function isValidCidV1Bytes(bytes: Uint8Array | null): boolean {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0x01) return false;
  const codec = readVarint(bytes, 1);
  if (!codec) return false;
  return isValidMultihash(bytes, codec[1]);
}

export function isValidCid(cid: unknown): cid is string {
  if (typeof cid !== "string") return false;

  if (CID_V0_PATTERN.test(cid)) {
    const bytes = decodeBase58(cid);
    // sha2-256 (0x12), 32-byte digest (0x20).
    return bytes !== null && bytes.length === 34 && bytes[0] === 0x12 && bytes[1] === 0x20;
  }
  if (CID_V1_BASE58_PATTERN.test(cid)) {
    return isValidCidV1Bytes(decodeBase58(cid.slice(1)));
  }
  if (CID_V1_BASE32_PATTERN.test(cid)) {
    return isValidCidV1Bytes(decodeBase32(cid.slice(1)));
  }
  return false;
}
