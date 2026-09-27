import { fnv1aHex, stableStringify } from "../utils/hash";

export function revisionFor(value: unknown): string {
  return fnv1aHex(stableStringify(value));
}
