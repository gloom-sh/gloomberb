import type { PluginPersistence } from "../../../types/plugin";
import { SidebarWidthSnapshotStore } from "../shared/snapshot-store";

const WIDTH_STATE_KEY = "chat-sidebar-width";
const COLLAPSED_SECTIONS_STATE_KEY = "chat-sidebar-collapsed-sections";

/** The two fixed sections; team sections fold through the team store instead. */
export type ChatSidebarSection = "public" | "direct";

const SECTIONS: readonly ChatSidebarSection[] = ["public", "direct"];

interface ChatSidebarSnapshot {
  /** Width in cells the person dragged the sidebar to; null follows the pane. */
  width: number | null;
  collapsedSections: ReadonlySet<ChatSidebarSection>;
}

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
class ChatSidebarStore extends SidebarWidthSnapshotStore<ChatSidebarSnapshot> {
  constructor() {
    super(EMPTY, WIDTH_STATE_KEY);
  }

  attach(persistence: PluginPersistence): void {
    this.persistence = persistence;
    const collapsed = persistence.getState<string[]>(COLLAPSED_SECTIONS_STATE_KEY);
    this.update({
      width: this.readPersistedWidth(persistence),
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

  /** Test hook: drops both the persisted handle and the in-memory shape. */
  reset(): void {
    this.persistence = null;
    this.update(EMPTY);
  }
}

export const chatSidebarStore = new ChatSidebarStore();
