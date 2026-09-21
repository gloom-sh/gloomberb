import type {
  ASKGConversationSummary,
  ASKGTransport,
} from "../../../../api-client/askg";
import { readStoredPaneSidebarWidth } from "../../../../components";
import type { PluginPersistence } from "../../../../types/plugin";

const WIDTH_STATE_KEY = "askg-sidebar-width";

export interface ASKGConversationListSnapshot {
  conversations: ASKGConversationSummary[];
  loading: boolean;
  /** Set when the last refresh failed; the list keeps its previous rows. */
  error: string | null;
  loaded: boolean;
  /** Width in cells the person dragged the sidebar to; null follows the pane. */
  width: number | null;
}

const EMPTY: ASKGConversationListSnapshot = {
  conversations: [],
  loading: false,
  error: null,
  loaded: false,
  width: null,
};

type Listener = () => void;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Conversations unavailable.";
}

/**
 * The conversations the sidebar lists, and how wide it was dragged.
 *
 * Global rather than per pane: the list belongs to the account, so a second
 * Ask Gloom window reads the same rows and a conversation renamed in one
 * appears renamed in the other. The transcript itself is not cached here; it
 * is loaded on open and handed straight to the controller, which owns the one
 * conversation being read.
 */
export class ASKGConversationListStore {
  private snapshot = EMPTY;
  private readonly listeners = new Set<Listener>();
  private persistence: PluginPersistence | null = null;
  private transport: ASKGTransport | null = null;
  private inFlight: Promise<void> | null = null;

  getSnapshot(): ASKGConversationListSnapshot {
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
    this.update({
      width: readStoredPaneSidebarWidth(persistence.getState(WIDTH_STATE_KEY)),
    });
  }

  /** The pane installs its transport, so the store never reaches for a global. */
  useTransport(transport: ASKGTransport): void {
    this.transport = transport;
  }

  /**
   * Reloads the list. Concurrent callers share one request, which is what
   * happens when two panes mount together or a turn finishes while the first
   * refresh is still open.
   */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const transport = this.transport;
    if (!transport) return Promise.resolve();
    this.update({ loading: true });
    const request = transport
      .listConversations()
      .then((conversations) => {
        this.update({
          conversations,
          loading: false,
          error: null,
          loaded: true,
        });
      })
      .catch((error: unknown) => {
        // The rows already on screen are still the best answer available.
        this.update({ loading: false, error: describeError(error) });
      })
      .finally(() => {
        if (this.inFlight === request) this.inFlight = null;
      });
    this.inFlight = request;
    return request;
  }

  /** Reloads only once, for a pane that just mounted. */
  ensureLoaded(): void {
    if (this.snapshot.loaded || this.inFlight) return;
    void this.refresh();
  }

  async rename(id: string, title: string | null): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    // Optimistic: the row reads as renamed while the request is open, and a
    // refusal is corrected by the refresh that follows.
    this.replace(id, (conversation) => ({ ...conversation, title }));
    try {
      const renamed = await transport.renameConversation(id, title);
      if (renamed) this.replace(id, () => renamed);
      else this.remove(id);
    } catch (error) {
      this.update({ error: describeError(error) });
      void this.refresh();
    }
  }

  async delete(id: string): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    const previous = this.snapshot.conversations;
    this.remove(id);
    try {
      await transport.deleteConversation(id);
    } catch (error) {
      this.update({ conversations: previous, error: describeError(error) });
    }
  }

  /**
   * Folds a conversation the pane just learned about into the list without
   * waiting for a round trip, so a first question appears in the sidebar as
   * soon as it is asked. A conversation already listed is left where it is:
   * merely opening one is not a reason to move it to the top.
   */
  note(id: string, title: string | null, at = new Date().toISOString()): void {
    const existing = this.snapshot.conversations.some(
      (conversation) => conversation.id === id,
    );
    if (existing) {
      this.replace(id, (conversation) => (
        conversation.title ? conversation : { ...conversation, title }
      ));
      return;
    }
    this.update({
      conversations: [
        {
          id,
          title,
          messageCount: 0,
          lastMessageAt: at,
          createdAt: at,
          updatedAt: at,
        },
        ...this.snapshot.conversations,
      ],
    });
  }

  /** Live drag feedback: updates every frame without touching persistence. */
  setWidth(width: number): void {
    if (this.snapshot.width === width) return;
    this.update({ width });
  }

  /** Called once a drag settles, so a resize survives a restart. */
  commitWidth(width: number): void {
    this.setWidth(width);
    this.persistence?.setState(WIDTH_STATE_KEY, width);
  }

  /** Test hook: drops the persisted handle, the transport and the rows. */
  reset(): void {
    this.persistence = null;
    this.transport = null;
    this.inFlight = null;
    this.snapshot = EMPTY;
  }

  private replace(
    id: string,
    patch: (conversation: ASKGConversationSummary) => ASKGConversationSummary,
  ): void {
    const conversations = this.snapshot.conversations.map((conversation) =>
      conversation.id === id ? patch(conversation) : conversation,
    );
    this.update({ conversations });
  }

  private remove(id: string): void {
    this.update({
      conversations: this.snapshot.conversations.filter(
        (conversation) => conversation.id !== id,
      ),
    });
  }

  private update(patch: Partial<ASKGConversationListSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export const askgConversationListStore = new ASKGConversationListStore();

/** What a row with no title of its own is called. */
export const UNTITLED_ASKG_CONVERSATION = "New conversation";

export function askgConversationLabel(
  conversation: ASKGConversationSummary,
): string {
  return conversation.title?.trim() || UNTITLED_ASKG_CONVERSATION;
}
