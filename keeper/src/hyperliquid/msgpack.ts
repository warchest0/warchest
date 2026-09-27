/**
 * Minimal, deterministic MessagePack encoder — exactly the subset Hyperliquid's action hash needs (the Python SDK
 * does `msgpack.packb(action)` with default settings): nil, bool, non-negative and negative integers, strings,
 * arrays, maps (keys in INSERTION order) and raw bytes. Floats are refused on purpose: every price/size on the wire
 * is a decimal string, and a float would silently change the hash.
 *
 * Cross-checked in tests against `@msgpack/msgpack` and against the Hyperliquid Python SDK signature vectors.
 */

export type Packable = null | boolean | number | bigint | string | Uint8Array | Packable[] | { [k: string]: Packable };

class Writer {
  private buf = new Uint8Array(256);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  uint(n: bigint, width: 1 | 2 | 4 | 8): void {
    this.ensure(width);
    for (let i = width - 1; i >= 0; i--) {
      this.buf[this.len + i] = Number(n & 0xffn);
      n >>= 8n;
    }
    this.len += width;
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const enc = new TextEncoder();

function packInt(w: Writer, n: bigint): void {
  if (n >= 0n) {
    if (n < 0x80n) w.u8(Number(n));
    else if (n <= 0xffn) (w.u8(0xcc), w.uint(n, 1));
    else if (n <= 0xffffn) (w.u8(0xcd), w.uint(n, 2));
    else if (n <= 0xffffffffn) (w.u8(0xce), w.uint(n, 4));
    else if (n <= 0xffffffffffffffffn) (w.u8(0xcf), w.uint(n, 8));
    else throw new Error("msgpack: integer too large");
  } else {
    if (n >= -0x20n) w.u8(Number(n & 0xffn));
    else if (n >= -0x80n) (w.u8(0xd0), w.uint(n & 0xffn, 1));
    else if (n >= -0x8000n) (w.u8(0xd1), w.uint(n & 0xffffn, 2));
    else if (n >= -0x80000000n) (w.u8(0xd2), w.uint(n & 0xffffffffn, 4));
    else if (n >= -0x8000000000000000n) (w.u8(0xd3), w.uint(n & 0xffffffffffffffffn, 8));
    else throw new Error("msgpack: integer too small");
  }
}

function packLen(w: Writer, n: number, fix: { max: number; base: number } | undefined, b8: number | undefined, b16: number, b32: number): void {
  if (fix && n <= fix.max) w.u8(fix.base | n);
  else if (b8 !== undefined && n <= 0xff) (w.u8(b8), w.uint(BigInt(n), 1));
  else if (n <= 0xffff) (w.u8(b16), w.uint(BigInt(n), 2));
  else if (n <= 0xffffffff) (w.u8(b32), w.uint(BigInt(n), 4));
  else throw new Error("msgpack: too long");
}

function pack(w: Writer, v: Packable): void {
  if (v === null || v === undefined) return w.u8(0xc0);
  if (typeof v === "boolean") return w.u8(v ? 0xc3 : 0xc2);
  if (typeof v === "bigint") return packInt(w, v);
  if (typeof v === "number") {
    if (!Number.isInteger(v) || !Number.isSafeInteger(v)) throw new Error(`msgpack: refusing non-integer number ${v} (use a decimal string)`);
    return packInt(w, BigInt(v));
  }
  if (typeof v === "string") {
    const b = enc.encode(v);
    packLen(w, b.length, { max: 31, base: 0xa0 }, 0xd9, 0xda, 0xdb);
    return w.bytes(b);
  }
  if (v instanceof Uint8Array) {
    packLen(w, v.length, undefined, 0xc4, 0xc5, 0xc6);
    return w.bytes(v);
  }
  if (Array.isArray(v)) {
    packLen(w, v.length, { max: 15, base: 0x90 }, undefined, 0xdc, 0xdd);
    for (const x of v) pack(w, x);
    return;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    packLen(w, keys.length, { max: 15, base: 0x80 }, undefined, 0xde, 0xdf);
    for (const k of keys) {
      pack(w, k);
      pack(w, v[k] as Packable);
    }
    return;
  }
  throw new Error(`msgpack: unsupported value ${typeof v}`);
}

export function encodeMsgpack(v: Packable): Uint8Array {
  const w = new Writer();
  pack(w, v);
  return w.done();
}
