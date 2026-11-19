import type { ResourceCacheKey } from "./resource-store";

type ScopeMatcher = (key: ResourceCacheKey) => boolean;

/** Matches the display scope, including its legacy research form, in composite cache keys. */
export function proResourceMatcher(account: string): ScopeMatcher {
  const research = JSON.stringify([account, true]);
  let markers = [JSON.stringify([account, true, true]), `${research}:pro`, `${research}:full`];
  const encoded = [...markers];
  for (let depth = 0; depth < 4; depth += 1) {
    markers = markers.map((marker) => JSON.stringify(marker).slice(1, -1));
    encoded.push(...markers);
  }
  return ({ namespace, entityKey, sourceKey }) => (
    (namespace === "market" || namespace.startsWith("pane:") || namespace.startsWith("plugin:"))
    && encoded.some((marker) => entityKey.includes(marker) || sourceKey?.includes(marker))
  );
}

/** A revoked scope may still have requests in flight. Reject their late cache writes. */
export class ProResourceAccess {
  private readonly revoked = new Map<string, ScopeMatcher>();

  update(account: string, allowed: boolean): ScopeMatcher | null {
    if (allowed) this.revoked.delete(account);
    else if (!this.revoked.has(account)) {
      const matches = proResourceMatcher(account);
      this.revoked.set(account, matches);
      return matches;
    }
    return null;
  }

  permits(key: ResourceCacheKey): boolean {
    if (this.revoked.size === 0) return true;
    for (const matches of this.revoked.values()) if (matches(key)) return false;
    return true;
  }
}
