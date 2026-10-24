// Computes a TeamSpeak client UID from a stored identity, so the Identitäten dialog
// can show it without connecting. UID = base64(sha1(base64(tomcrypt public key DER))),
// same as tsproto's EccKeyPubP256::get_uid. Accepts what an identity blob can be:
// tsclientlib's JSON ({"key": base64 scalar}), a native "<counter>V<obfuscated>" string,
// or a plain base64 tomcrypt key. Needs crypto.subtle, so null on plain-http origins.

const OBFUSCATION = new TextEncoder().encode(
  "b9dfaa7bee6ac57ac7b65f1094a1c155e747327bc2fe5d51c512023fe54a280201004e90ad1daaae1075d53b7d571c30e063b5a62a4a017bb394833aa0983e6e"
);

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const sha1 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-1", data as BufferSource));

/** One DER element at pos -> [tag, content, end]. */
function derRead(buf: Uint8Array, pos: number): [number, Uint8Array, number] {
  let len = buf[pos + 1];
  let start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[start + i];
    start += n;
  }
  if (start + len > buf.length) throw new Error("bad der");
  return [buf[pos], buf.subarray(start, start + len), start + len];
}

/** Top-level DER sequence -> its elements as [tag, content]. */
function derSequence(der: Uint8Array): [number, Uint8Array][] {
  const [tag, body] = derRead(der, 0);
  if (tag !== 0x30) throw new Error("no sequence");
  const items: [number, Uint8Array][] = [];
  for (let pos = 0; pos < body.length; ) {
    const [t, content, end] = derRead(body, pos);
    items.push([t, content]);
    pos = end;
  }
  return items;
}

function derLength(n: number): number[] {
  return n < 0x80 ? [n] : [0x81, n];
}

/** DER INTEGER content for an unsigned big-endian number. */
function derUint(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const trimmed = bytes.subarray(i);
  return trimmed[0] & 0x80 ? Uint8Array.of(0, ...trimmed) : trimmed;
}

async function uidFromPoint(x: Uint8Array, y: Uint8Array): Promise<string> {
  const parts = [
    [0x03, 0x02, 0x07, 0x00], // BIT STRING: 1 bit, 0 = public key only
    [0x02, 0x01, 0x20], // INTEGER 32
    [0x02, ...derLength(x.length), ...x],
    [0x02, ...derLength(y.length), ...y],
  ].flat();
  const der = Uint8Array.of(0x30, ...derLength(parts.length), ...parts);
  return b64(await sha1(new TextEncoder().encode(b64(der))));
}

/** Public point from a bare P-256 scalar, via a PKCS#8 import without public key. */
async function uidFromScalar(scalar: Uint8Array): Promise<string> {
  const d = new Uint8Array(32);
  d.set(scalar.subarray(Math.max(0, scalar.length - 32)), 32 - Math.min(32, scalar.length));
  const pkcs8 = Uint8Array.of(
    ...[0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01],
    ...[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20],
    ...d
  );
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const fromUrl = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return uidFromPoint(derUint(fromUrl(jwk.x!)), derUint(fromUrl(jwk.y!)));
}

/** tomcrypt private key DER (with or without the public point, like tsproto's from_tomcrypt). */
async function uidFromTomcrypt(der: Uint8Array): Promise<string> {
  const items = derSequence(der);
  const [bitTag, bits] = items[0];
  if (bitTag !== 0x03) throw new Error("no bit string");
  // TS3AudioBot keys set two bits and leave out the public point.
  const withPoint = bits[0] === 0x07;
  if (withPoint) return uidFromPoint(items[2][1], items[3][1]);
  return uidFromScalar(items[2][1]);
}

async function deobfuscate(data: Uint8Array): Promise<Uint8Array> {
  const out = data.slice();
  let end = out.indexOf(0, 20);
  if (end < 0) end = out.length;
  const hash = await sha1(out.subarray(20, end));
  for (let i = 0; i < 20; i++) out[i] ^= hash[i];
  for (let i = 0; i < Math.min(out.length, 100); i++) out[i] ^= OBFUSCATION[i];
  return out;
}

export async function identityUid(blob: string): Promise<string | null> {
  if (!crypto.subtle) return null;
  try {
    const text = blob.trim().replace(/^"|"$/g, "");
    if (text.startsWith("{")) return await uidFromScalar(unb64(JSON.parse(text).key));
    const native = /^\d+V(.+)$/.exec(text);
    const tomcrypt = native ? atob(new TextDecoder().decode(await deobfuscate(unb64(native[1])))) : atob(text);
    return await uidFromTomcrypt(Uint8Array.from(tomcrypt, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}
