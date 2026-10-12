import type { AccountProfile, AccountProfileUpdate } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { t, tf } from "../../../i18n";
import type { PluginPersistence } from "../../../types/plugin";

/**
 * The handle signup gives an account on the website and through Google or
 * GitHub (`gloom_` and 16 hex digits) until its person picks one. Only this
 * exact shape is asked about: a name someone chose, or one derived at an app
 * signup, is left alone.
 */
const PLACEHOLDER_USERNAME = /^gloom_[0-9a-f]{16}$/;

export function isPlaceholderUsername(username: string | null | undefined): boolean {
  return typeof username === "string" && PLACEHOLDER_USERNAME.test(username);
}

/** What was typed, as a handle: no spaces around it and no leading @. */
export function normalizeHandleInput(value: string): string {
  return value.trim().replace(/^@+/, "").trim();
}

/**
 * The patch a chosen handle saves. A name signup filled in with the
 * placeholder goes with it, so the random string leaves the card too; a name
 * the person or their Google or GitHub account gave is kept.
 */
export function handleProfileUpdate(profile: Pick<AccountProfile, "name" | "username">, handle: string): AccountProfileUpdate {
  const name = profile.name.trim().toLowerCase();
  const placeholderName = isPlaceholderUsername(profile.username) && name === profile.username?.toLowerCase();
  return placeholderName ? { username: handle, name: handle } : { username: handle };
}

/**
 * The server's own rule (letters, digits and _, starting with a letter, 3 to
 * 30 long), used only to word its refusal: a handle of that shape it still
 * refused is one it keeps for itself. The server decides either way.
 */
const HANDLE_SHAPE = /^[a-zA-Z][a-zA-Z0-9_]{2,29}$/;

/** A refused or failed save as one line the person can act on. */
export function describeHandleSaveError(error: unknown, handle: string): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 409) return tf("@{handle} is taken. Try another.", { handle });
    if (error.status === 400) {
      return HANDLE_SHAPE.test(handle)
        ? tf("@{handle} isn't available. Try another.", { handle })
        : t("Use 3-30 letters, numbers or _, starting with a letter.");
    }
  }
  return t("Couldn't save your handle. Try again.");
}

const DISMISSED_STATE_KEY = "chat-handle-prompt-dismissed";
/** Accounts this device remembers saying "Not now" for; the oldest go first. */
const MAX_DISMISSED_ACCOUNTS = 50;

interface ChatHandlePromptSnapshot {
  /** Account ids that said "Not now" on this device. */
  dismissed: ReadonlySet<string>;
  /** Account ids that saved a handle this session, until their session catches up. */
  saved: ReadonlySet<string>;
}

type Listener = (snapshot: ChatHandlePromptSnapshot) => void;

const EMPTY: ChatHandlePromptSnapshot = { dismissed: new Set(), saved: new Set() };

/**
 * Whether chat still offers an account its handle, shared by every chat pane.
 * "Not now" is kept per account on this device, so the prompt does not come
 * back on the next open and another account signing in here is still asked.
 */
class ChatHandlePromptStore {
  private snapshot: ChatHandlePromptSnapshot = EMPTY;
  private readonly listeners = new Set<Listener>();
  private persistence: PluginPersistence | null = null;

  getSnapshot(): ChatHandlePromptSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  attach(persistence: PluginPersistence): void {
    this.persistence = persistence;
    const stored = persistence.getState<unknown>(DISMISSED_STATE_KEY);
    const dismissed = Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    this.update({ dismissed: new Set(dismissed) });
  }

  /** The prompt is still on offer to this account. */
  isOffered(userId: string): boolean {
    return !this.snapshot.dismissed.has(userId) && !this.snapshot.saved.has(userId);
  }

  dismiss(userId: string): void {
    if (this.snapshot.dismissed.has(userId)) return;
    const next = [...this.snapshot.dismissed, userId].slice(-MAX_DISMISSED_ACCOUNTS);
    this.update({ dismissed: new Set(next) });
    this.persistence?.setState(DISMISSED_STATE_KEY, next);
  }

  markSaved(userId: string): void {
    if (this.snapshot.saved.has(userId)) return;
    this.update({ saved: new Set([...this.snapshot.saved, userId]) });
  }

  /** Test hook: drops the persisted handle and everything remembered. */
  reset(): void {
    this.persistence = null;
    this.update(EMPTY);
  }

  private update(patch: Partial<ChatHandlePromptSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

export const chatHandlePromptStore = new ChatHandlePromptStore();
