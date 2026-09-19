import type { PluginPersistence } from "../../../types/plugin";

const WIDTH_STATE_KEY = "chat-sidebar-width";
const COLLAPSED_SECTIONS_STATE_KEY = "chat-sidebar-collapsed-sections";

/** The two fixed sections; team sections fold through the team store instead. */
export type ChatSidebarSection = "public" | "direct";

const SECTIONS: readonly ChatSidebarSection[] = ["public", "direct"];

export interface ChatSidebarSnapshot {
  /** Width in cells the person dragged the sidebar to; null follows the pane. */
  width: number | null;
  collapsedSections: ReadonlySet<ChatSidebarSection>;
}

type Listener = (snapshot: ChatSidebarSnapshot) => void;

const EMPTY: ChatSidebarSnapshot = {
  width: null,
  collapsedSections: new Set(),
};

function isSection(value: unknown): value is ChatSidebarSection {
  return SECTIONS.includes(value as ChatSidebarSection);
}

/**
 * Per-device chat sidebar shape: how wide it was dragged and which of its
 * fixed sections are folded. Global rather than per-pane so every open chat
 * pane reads the same sidebar, the way folded teams already do.
 */
export class ChatSidebarStore {
  private snapshot: ChatSidebarSnapshot = EMPTY;
  private readonly listeners = new Set<Listener>();
  private persistence: PluginPersistence | null = null;

  getSnapshot(): ChatSidebarSnapshot {
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
    const width = persistence.getState<number>(WIDTH_STATE_KEY);
    const collapsed = persistence.getState<string[]>(COLLAPSED_SECTIONS_STATE_KEY);
    this.update({
      width: typeof width === "number" && Number.isFinite(width) ? width : null,
      collapsedSections: new Set(Array.isArray(collapsed) ? collapsed.filter(isSection) : []),
    });
  }

  isSectionCollapsed(section: ChatSidebarSection): boolean {
    return this.snapshot.collapsedSections.has(section);
  }

  setSectionCollapsed(section: ChatSidebarSection, collapsed: boolean): void {
    if (this.isSectionCollapsed(section) === collapsed) return;
    const next = new Set(this.snapshot.collapsedSections);
    if (collapsed) next.add(section);
    else next.delete(section);
    this.update({ collapsedSections: next });
    this.persistence?.setState(COLLAPSED_SECTIONS_STATE_KEY, [...next]);
  }

  toggleSectionCollapsed(section: ChatSidebarSection): void {
    this.setSectionCollapsed(section, !this.isSectionCollapsed(section));
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

  /** Test hook: drops both the persisted handle and the in-memory shape. */
  reset(): void {
    this.persistence = null;
    this.update(EMPTY);
  }

  private update(patch: Partial<ChatSidebarSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

export const chatSidebarStore = new ChatSidebarStore();
