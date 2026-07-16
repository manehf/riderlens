import { describe, expect, it } from "vitest";

import { decodeBase64, hasTopLevelMoofAtom } from "../src/services/videoFormat";

function atom(type: string, payload = 0): Uint8Array {
  const size = 8 + payload;
  const bytes = new Uint8Array(size);
  bytes[0] = (size >> 24) & 0xff;
  bytes[1] = (size >> 16) & 0xff;
  bytes[2] = (size >> 8) & 0xff;
  bytes[3] = size & 0xff;
  for (let i = 0; i < 4; i += 1) bytes[4 + i] = type.charCodeAt(i);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("hasTopLevelMoofAtom", () => {
  it("flags fragmented layouts: ftyp, moov, then moof", () => {
    expect(hasTopLevelMoofAtom(concat(atom("ftyp", 24), atom("moov", 900), atom("moof", 100)))).toBe(true);
  });

  it("passes regular layouts: media data before any fragment", () => {
    expect(hasTopLevelMoofAtom(concat(atom("ftyp", 24), atom("moov", 900), atom("mdat", 4000)))).toBe(false);
  });

  it("stops at 64-bit-sized atoms instead of walking into media", () => {
    const wide = atom("mdat");
    wide[0] = 0;
    wide[1] = 0;
    wide[2] = 0;
    wide[3] = 1; // size=1 sentinel: real length is 64-bit
    expect(hasTopLevelMoofAtom(concat(atom("ftyp", 24), wide, atom("moof", 100)))).toBe(false);
  });

  it("rejects non-atom garbage without looping", () => {
    expect(hasTopLevelMoofAtom(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBe(false);
  });
});

describe("decodeBase64", () => {
  it("round-trips against node's decoder", () => {
    const source = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256);
    const encoded = Buffer.from(source).toString("base64");
    expect(Array.from(decodeBase64(encoded))).toEqual(Array.from(source));
  });
});
