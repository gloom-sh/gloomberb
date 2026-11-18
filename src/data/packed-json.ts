import { gzipSync, gunzipSync } from "fflate";
import { decodeBase64, encodeBase64 } from "../utils/http-proxy-response";

const COMPRESSED = "gzip:";
const MIN_COMPRESSED_LENGTH = 16 * 1024;
const MAX_INFLATED_LENGTH = 32 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function packJson(json: string): string {
  if (json.length < MIN_COMPRESSED_LENGTH || json.length > MAX_INFLATED_LENGTH || json.startsWith(COMPRESSED)) return json;
  const bytes = encoder.encode(json);
  if (bytes.length > MAX_INFLATED_LENGTH) return json;
  const compressed = typeof Bun !== "undefined" ? Bun.gzipSync(bytes, { level: 1 }) : gzipSync(bytes, { level: 1, mtime: 0 });
  const packed = COMPRESSED + encodeBase64(compressed);
  return packed.length < json.length ? packed : json;
}

export function unpackJson(value: string): string {
  if (!value.startsWith(COMPRESSED)) return value;
  const bytes = decodeBase64(value.slice(COMPRESSED.length));
  if (!bytes || bytes.length < 18) throw new Error("Invalid compressed JSON");
  const length = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4).getUint32(0, true);
  if (length > MAX_INFLATED_LENGTH) throw new Error("Compressed JSON exceeds the size limit");
  return decoder.decode(gunzipSync(bytes, { out: new Uint8Array(length) }));
}
