export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/**
 * Lightweight browser-native ZIP extractor supporting Stored (0) and Deflate (8) entries.
 * Parses End of Central Directory (EOCD) so data descriptors (bit 3) with zeroed sizes work reliably.
 */
export async function extractZipEntries(buffer: ArrayBuffer): Promise<ZipEntry[]> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Locate End of Central Directory (PK\x05\x06) searching backwards
  let eocdOffset = -1;
  const minOffset = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP archive: central directory not found.');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  let cdOffset = view.getUint32(eocdOffset + 16, true);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < totalEntries && cdOffset + 46 <= bytes.length; i++) {
    const sig = view.getUint32(cdOffset, true);
    if (sig !== 0x02014b50) break;

    const method = view.getUint16(cdOffset + 10, true);
    const compSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);

    const nameBytes = bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen);
    const name = new TextDecoder().decode(nameBytes);
    cdOffset += 46 + nameLen + extraLen + commentLen;

    // Skip directories
    if (name.endsWith('/')) continue;

    if (localHeaderOffset + 30 > bytes.length) continue;
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) continue;

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = Math.min(bytes.length, dataStart + compSize);
    const compressed = bytes.subarray(dataStart, dataEnd);

    if (method === 0) {
      entries.push({ name, bytes: new Uint8Array(compressed) });
    } else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('Browser does not support deflate decompression.');
      }
      const copy = new Uint8Array(compressed.length);
      copy.set(compressed);
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([copy.buffer]).stream().pipeThrough(ds);
      const decompressedBuf = await new Response(stream).arrayBuffer();
      entries.push({ name, bytes: new Uint8Array(decompressedBuf) });
    }
  }

  return entries;
}

export function isZipBuffer(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05)
  );
}
