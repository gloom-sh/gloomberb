import type { PersistedAuthUser } from "../../api-client";

const STORAGE_KEY = "gloomberb.web.session-display.v1";
const SESSION_BINDING = /^[a-f0-9]{64}$/;

export function readBrowserSessionUser(storage: Pick<Storage, "getItem">, binding: string | null): PersistedAuthUser | null {
  if (!binding || !SESSION_BINDING.test(binding)) return null;
  try {
    const record = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    if (record?.binding !== binding || typeof record.user?.id !== "string" || !record.user.id) return null;
    return record.user;
  } catch {
    // Intentional ignore: broken display records never restore a user.
    return null;
  }
}

export function rememberBrowserSessionUser(storage: Pick<Storage, "setItem" | "removeItem">, binding: string, user: PersistedAuthUser | null): void {
  if (!user?.id || !SESSION_BINDING.test(binding)) {
    storage.removeItem(STORAGE_KEY);
    return;
  }
  const { id, name, username, emailVerified, plan, effectivePlan, trialEndsAt } = user;
  storage.setItem(STORAGE_KEY, JSON.stringify({ binding, user: { id, name, username, emailVerified, plan, effectivePlan, trialEndsAt } }));
}
