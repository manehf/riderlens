// Fragmented MP4s (streaming containers: moov followed by moof/mdat pairs)
// defeat precise AVFoundation/ExoPlayer seeking, so the trim preview scrubs
// unreliably even though worker-side analysis handles them fine. Cameras
// never produce them — screen recorders and stream downloaders do — so the
// picker just warns rather than blocks.

const SNIFF_BYTES = 65536;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = new Map<string, number>([...BASE64_ALPHABET].map((char, index) => [char, index]));

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of clean) {
    const value = BASE64_LOOKUP.get(char);
    if (value === undefined) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, offset);
}

/** Walk top-level MP4 atoms; a `moof` before any `mdat` marks a fragmented
 * container. Regular files reach their single `mdat` first. */
export function hasTopLevelMoofAtom(bytes: Uint8Array): boolean {
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size =
      (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    size = size >>> 0;
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    if (!/^[\x20-\x7e]{4}$/.test(type)) return false;
    if (type === "moof") return true;
    if (type === "mdat") return false;
    if (size === 1) {
      // 64-bit atom length: anything that large in the head of the file is a
      // regular media blob, not fragment bookkeeping.
      return false;
    }
    if (size < 8) return false;
    offset += size;
  }
  return false;
}

export async function isLikelyFragmentedMp4(uri: string): Promise<boolean> {
  try {
    // Lazy require keeps this module importable in node test runs.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const FileSystem = require("expo-file-system");
    const head = await FileSystem.readAsStringAsync(uri, {
      encoding: "base64",
      position: 0,
      length: SNIFF_BYTES
    });
    return hasTopLevelMoofAtom(decodeBase64(head));
  } catch {
    return false;
  }
}
