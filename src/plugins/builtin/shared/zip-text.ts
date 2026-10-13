export interface ZipTextEntry {
  name: string;
  text: string;
}

const LOCAL_FILE = 0x04034b50;

/** Raw deflate, the method these public zips use. The desktop view has no node:zlib. */
async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const copy = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(copy).set(compressed);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Reads deflate and stored members from a zip whose local headers carry sizes.
 * Ken French and JODI publish that form. Zip64 and data-descriptor members are refused.
 */
export async function readZipTexts(bytes: Uint8Array): Promise<ZipTextEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ZipTextEntry[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === LOCAL_FILE) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (flags & 0x8) throw new Error("The archive defers file sizes");
    if (dataEnd > bytes.length) throw new Error("The archive is truncated");
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (!name.endsWith("/")) {
      const compressed = bytes.subarray(dataStart, dataEnd);
      const raw = method === 0 ? compressed : method === 8 ? await inflateRaw(compressed) : null;
      if (!raw) throw new Error(`Cannot read ${name}`);
      entries.push({ name, text: new TextDecoder("latin1").decode(raw) });
    }
    offset = dataEnd;
  }
  if (entries.length === 0) throw new Error("The archive had no files");
  return entries;
}
