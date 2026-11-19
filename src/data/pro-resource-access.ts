import type { ResourceCacheKey } from "./resource-store";
import { isBrokerAccountSnapshotKey } from "../brokers/account-cache";

type ScopeMatcher = (key: ResourceCacheKey) => boolean;

function mayHaveDisplayScope(key: ResourceCacheKey): boolean {
  const { namespace } = key;
  return !isBrokerAccountSnapshotKey(key) && (namespace === "market" || namespace.startsWith("pane:") || namespace.startsWith("plugin:"));
}

const SCOPE_ENCODING_DEPTH = 4;
const PRO_SCOPE_SUFFIX = /,true(?:,true\]|\]:(?:pro|full))/;
const PRO_SCOPE = /\[("(?:[^"\\]|\\.)*"),true(?:,true\]|\]:(?:pro|full))/g;

export function proResourceAccounts(key: ResourceCacheKey): string[] {
  if (!mayHaveDisplayScope(key)) return [];
  const accounts = new Set<string>();
  for (const part of [key.entityKey, key.sourceKey ?? ""]) {
    if (!PRO_SCOPE_SUFFIX.test(part)) continue;
    let decoded = part;
    for (let depth = 0; depth <= SCOPE_ENCODING_DEPTH; depth += 1) {
      for (const [, literal] of decoded.matchAll(PRO_SCOPE)) {
        let account: string;
        try { account = JSON.parse(literal!); } catch { continue; }
        if (!accounts.has(account) && proResourceMatcher(account)(key)) accounts.add(account);
      }
      const unescaped = decoded.replace(/\\(["\\])/g, "$1");
      if (unescaped === decoded) break;
      decoded = unescaped;
    }
  }
  return [...accounts];
}

/** Matches the display scope, including its legacy research form, in composite cache keys. */
export function proResourceMatcher(account: string): ScopeMatcher {
  const research = JSON.stringify([account, true]);
  let markers = [JSON.stringify([account, true, true]), `${research}:pro`, `${research}:full`];
  const encoded = [...markers];
  for (let depth = 0; depth < SCOPE_ENCODING_DEPTH; depth += 1) {
    markers = markers.map((marker) => JSON.stringify(marker).slice(1, -1));
    encoded.push(...markers);
  }
  return (key) => (
    mayHaveDisplayScope(key)
    && encoded.some((marker) => key.entityKey.includes(marker) || key.sourceKey?.includes(marker))
  );
}

/** A revoked scope may still have requests in flight. Reject their late cache writes. */
export class ProResourceAccess {
  private readonly allowed = new Map<string, boolean>();
  private readonly revoked = new Map<string, ScopeMatcher>();

  update(account: string, allowed: boolean): boolean {
    if (this.allowed.get(account) === allowed) return false;
    this.allowed.set(account, allowed);
    if (allowed) this.revoked.delete(account);
    else this.revoked.set(account, proResourceMatcher(account));
    return true;
  }

  revokedMatcher(account: string): ScopeMatcher | undefined { return this.revoked.get(account); }
  get hasRevocations(): boolean { return this.revoked.size > 0; }

  permits(key: ResourceCacheKey): boolean {
    if (this.revoked.size === 0) return true;
    for (const matches of this.revoked.values()) if (matches(key)) return false;
    return true;
  }
}
