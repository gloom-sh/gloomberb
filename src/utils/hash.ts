/** 32-bit FNV-1a over UTF-16 code units, as eight lowercase hex digits. */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function fnv1aHashString(input: string): string {
  return `fnv1a:${fnv1aHex(input)}`;
}

/** JSON with object keys sorted at every depth, so equal values hash equally. */
export function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(object[key])}`
  )).join(",")}}`;
}
