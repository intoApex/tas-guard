// Ethereum-style signing with no dependencies, for Hyperliquid mode: keccak-256, secp256k1 ECDSA
// (RFC 6979 deterministic k, low-s, recovery id) and EIP-712 typed-data hashing.
//
// Plain JavaScript with BigInt. Checked byte for byte against the official Hyperliquid Python SDK
// (eth-account) in test/hl.test.js, using vectors from test/fixtures/gen-hl-vectors.py.
// Note: BigInt arithmetic is not constant-time. Keys never leave this process and signing happens
// locally, but don't run TAS Guard where an attacker can time it at scale.
import { createHmac } from "node:crypto";

// ---------- keccak-256 (the original Keccak padding 0x01, as Ethereum uses; not NIST SHA3-256's 0x06) ----------
const MASK64 = (1n << 64n) - 1n;
const KECCAK_RC = (() => {
  const rc = [];
  let lfsr = 1;
  for (let i = 0; i < 24; i++) {
    let c = 0n;
    for (let j = 0; j < 7; j++) {
      if (lfsr & 1) c ^= 1n << BigInt((1 << j) - 1);
      lfsr = lfsr & 0x80 ? ((lfsr << 1) ^ 0x71) & 0xff : (lfsr << 1) & 0xff;
    }
    rc.push(c);
  }
  return rc;
})();
// Rotation offsets r[x + 5y] and the pi permutation, generated as in the Keccak reference.
const KECCAK_ROT = (() => {
  const r = new Array(25).fill(0n);
  let x = 1, y = 0;
  for (let t = 0; t < 24; t++) {
    r[x + 5 * y] = BigInt((((t + 1) * (t + 2)) / 2) % 64);
    [x, y] = [y, (2 * x + 3 * y) % 5];
  }
  return r;
})();
const rotl = (v, n) => (n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK64);

function keccakF(s) {
  const C = new Array(5), B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) s[y + x] ^= D;
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], KECCAK_ROT[x + 5 * y]);
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) s[y + x] = B[y + x] ^ (~B[y + ((x + 1) % 5)] & MASK64 & B[y + ((x + 2) % 5)]);
    s[0] ^= KECCAK_RC[round];
  }
}

/** keccak-256 of bytes (Buffer/Uint8Array). Returns a 32-byte Buffer. */
export function keccak256(data) {
  const msg = Buffer.from(data);
  const rate = 136;
  const padded = Buffer.alloc((Math.floor(msg.length / rate) + 1) * rate);
  msg.copy(padded);
  padded[msg.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) s[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakF(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return out;
}

// ---------- secp256k1 ----------
const P = 2n ** 256n - 2n ** 32n - 977n;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const G = [GX, GY, 1n];
const INF = [0n, 1n, 0n];

const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function inv(a, m = P) {
  let [t, nt, r, nr] = [0n, 1n, m, mod(a, m)];
  if (nr === 0n) throw new Error("secp256k1: inverse of zero");
  while (nr !== 0n) { const q = r / nr; [t, nt] = [nt, t - q * nt]; [r, nr] = [nr, r - q * nr]; }
  return mod(t, m);
}
function powMod(b, e, m) {
  let r = 1n; b = mod(b, m);
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}

// Jacobian coordinates [X, Y, Z]: x = X/Z^2, y = Y/Z^3; Z = 0 is the point at infinity.
function dbl([X, Y, Z]) {
  if (Z === 0n || Y === 0n) return INF;
  const A = mod(X * X), B = mod(Y * Y), C = mod(B * B);
  const D = mod(2n * (mod((X + B) * (X + B)) - A - C));
  const E = mod(3n * A), F = mod(E * E);
  const X3 = mod(F - 2n * D);
  return [X3, mod(E * (D - X3) - 8n * C), mod(2n * Y * Z)];
}
function add(p, q) {
  if (p[2] === 0n) return q;
  if (q[2] === 0n) return p;
  const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q;
  const Z1Z1 = mod(Z1 * Z1), Z2Z2 = mod(Z2 * Z2);
  const U1 = mod(X1 * Z2Z2), U2 = mod(X2 * Z1Z1);
  const S1 = mod(Y1 * Z2 * Z2Z2), S2 = mod(Y2 * Z1 * Z1Z1);
  if (U1 === U2) return S1 === S2 ? dbl(p) : INF;
  const H = mod(U2 - U1), R = mod(S2 - S1), HH = mod(H * H), HHH = mod(H * HH), V = mod(U1 * HH);
  const X3 = mod(R * R - HHH - 2n * V);
  return [X3, mod(R * (V - X3) - S1 * HHH), mod(H * Z1 * Z2)];
}
function mul(p, k) {
  let r = INF;
  for (let i = BigInt(k.toString(2).length - 1); i >= 0n; i--) {
    r = dbl(r);
    if ((k >> i) & 1n) r = add(r, p);
  }
  return r;
}
function affine([X, Y, Z]) {
  if (Z === 0n) throw new Error("secp256k1: point at infinity");
  const zi = inv(Z), zi2 = mod(zi * zi);
  return [mod(X * zi2), mod(Y * zi2 * zi)];
}

const big = (bytes) => BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
const bytes32 = (n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex");

/** Parse a 0x-prefixed (or bare) 32-byte hex private key. Throws on anything else. Never logs it. */
export function parsePrivateKey(hex) {
  const s = String(hex ?? "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error("expected a 32-byte hex private key (0x followed by 64 hex characters)");
  const d = BigInt("0x" + s);
  if (d <= 0n || d >= N) throw new Error("private key out of range");
  return d;
}

function addressOfPoint([x, y]) {
  return "0x" + keccak256(Buffer.concat([bytes32(x), bytes32(y)])).subarray(12).toString("hex");
}

/** Lowercase 0x address of a private key (BigInt). */
export function privateKeyToAddress(d) { return addressOfPoint(affine(mul(G, d))); }

const hmac = (key, ...parts) => createHmac("sha256", key).update(Buffer.concat(parts)).digest();

/** RFC 6979 deterministic nonce for secp256k1 with HMAC-SHA256 (what eth-account and libsecp256k1 use). */
function* rfc6979(d, hash) {
  const x = bytes32(d);
  const h1 = bytes32(big(hash) % N);
  let V = Buffer.alloc(32, 1), K = Buffer.alloc(32, 0);
  K = hmac(K, V, Buffer.from([0]), x, h1); V = hmac(K, V);
  K = hmac(K, V, Buffer.from([1]), x, h1); V = hmac(K, V);
  for (;;) {
    V = hmac(K, V);
    const k = big(V);
    if (k >= 1n && k < N) yield k;
    K = hmac(K, V, Buffer.from([0])); V = hmac(K, V);
  }
}

/**
 * Sign a 32-byte hash. Returns { r, s, recovery } as BigInts/number, with low s (s <= n/2)
 * and the recovery id adjusted to match, exactly like eth-account.
 */
export function signHash(hash, d) {
  if (Buffer.from(hash).length !== 32) throw new Error("signHash: expected a 32-byte hash");
  const z = big(hash);
  for (const k of rfc6979(d, hash)) {
    const [x, y] = affine(mul(G, k));
    const r = x % N;
    if (r === 0n) continue;
    let s = mod(inv(k, N) * (z + r * d), N);
    if (s === 0n) continue;
    let recovery = Number(y & 1n) | (x >= N ? 2 : 0);
    if (s > N / 2n) { s = N - s; recovery ^= 1; }
    return { r, s, recovery };
  }
}

/** Recover the signer's lowercase address from a 32-byte hash and { r, s, recovery }. */
export function recoverAddress(hash, { r, s, recovery }) {
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new Error("recover: r or s out of range");
  const x = r + (recovery & 2 ? N : 0n);
  if (x >= P) throw new Error("recover: invalid r");
  const alpha = mod(x * x * x + 7n);
  let y = powMod(alpha, (P + 1n) / 4n, P);
  if (mod(y * y) !== alpha) throw new Error("recover: r is not on the curve");
  if (Number(y & 1n) !== (recovery & 1)) y = P - y;
  const ri = inv(r, N);
  const Q = add(mul([x, y, 1n], mod(s * ri, N)), mul(G, mod(-big(hash) * ri, N)));
  return addressOfPoint(affine(Q));
}

// ---------- EIP-712 ----------
const ATOMIC = /^(string|bytes|address|bool|bytes([1-9]|[12][0-9]|3[0-2])|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?)$/;

function encodeValue(type, value) {
  if (type === "string") return keccak256(Buffer.from(String(value), "utf8"));
  if (type === "bytes") return keccak256(toBytes(value));
  if (type === "bool") return bytes32(value === true || value === "true" ? 1n : 0n);
  if (type === "address") {
    const s = String(value).replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{40}$/.test(s)) throw new Error(`EIP-712: '${value}' is not an address`);
    return bytes32(BigInt("0x" + s));
  }
  let m = /^bytes(\d+)$/.exec(type);
  if (m) {
    const b = toBytes(value);
    if (b.length !== Number(m[1])) throw new Error(`EIP-712: ${type} value has ${b.length} bytes`);
    return Buffer.concat([b, Buffer.alloc(32 - b.length)]);
  }
  m = /^(u?)int(\d*)$/.exec(type);
  if (m) {
    const bits = BigInt(m[2] || 256);
    let n = BigInt(value);
    if (m[1] === "u" ? n < 0n || n >= 1n << bits : n < -(1n << (bits - 1n)) || n >= 1n << (bits - 1n)) throw new Error(`EIP-712: ${value} doesn't fit ${type}`);
    if (n < 0n) n += 1n << 256n;
    return bytes32(n);
  }
  throw new Error(`EIP-712: unsupported type ${type}`);
}
function toBytes(v) {
  if (typeof v === "string") {
    const s = v.replace(/^0x/i, "");
    if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error("EIP-712: expected hex bytes");
    return Buffer.from(s, "hex");
  }
  return Buffer.from(v);
}

/** hashStruct for a struct whose fields are all atomic types (all that Hyperliquid needs). */
export function hashStruct(name, types, data) {
  const fields = types[name];
  if (!fields) throw new Error(`EIP-712: unknown type ${name}`);
  for (const f of fields) if (!ATOMIC.test(f.type)) throw new Error(`EIP-712: only atomic field types are supported (${name}.${f.name}: ${f.type})`);
  const typeHash = keccak256(Buffer.from(`${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`, "utf8"));
  return keccak256(Buffer.concat([typeHash, ...fields.map((f) => {
    if (data[f.name] === undefined) throw new Error(`EIP-712: ${name}.${f.name} is missing`);
    return encodeValue(f.type, data[f.name]);
  })]));
}

/** The EIP-712 digest that gets signed: keccak256(0x1901 || domainSeparator || hashStruct(message)). */
export function typedDataDigest({ domain, types, primaryType, message }) {
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), hashStruct("EIP712Domain", types, domain), hashStruct(primaryType, types, message)]));
}

/** Sign EIP-712 typed data. Returns the signature in the Python SDK's format: { r: "0x..", s: "0x..", v: 27|28 }. */
export function signTypedData(typedData, d) {
  const digest = typedDataDigest(typedData);
  const sig = signHash(digest, d);
  // Self-check: the signature must recover to the signing key's address, or nothing is sent.
  if (recoverAddress(digest, sig) !== privateKeyToAddress(d)) throw new Error("signature self-check failed");
  // r and s as minimal hex, like the SDK's eth_utils.to_hex(int); Hyperliquid parses them as numbers.
  return { r: "0x" + sig.r.toString(16), s: "0x" + sig.s.toString(16), v: 27 + sig.recovery };
}
