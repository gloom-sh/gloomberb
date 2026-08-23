import type { GloomPlugin } from "../../../types/plugin";
import { NotesFiles } from "./files";
import { createQuickNotesPane } from "./quick-notes-pane";
import { createNotesSyncContributor } from "./sync";
import { createNotesTab } from "./ticker-notes-tab";

export const notesPlugin: GloomPlugin = {
  id: "notes",
  name: "Notes",
  version: "1.0.0",
  description: "Add markdown notes to your tickers.",
  toggleable: true,

  setup(ctx) {
    const notesFiles = new NotesFiles(ctx.getConfig().dataDir);
    const NotesTab = createNotesTab(notesFiles);
    const QuickNotesPane = createQuickNotesPane(notesFiles);

    ctx.on("ticker:removed", ({ symbol }) => {
      notesFiles.delete(symbol).catch((error) => {
        console.error("[notes] Failed to delete ticker note:", error);
        ctx.notify({ body: "Failed to delete note. Check disk space and permissions.", type: "error" });
      });
    });

    ctx.registerSyncContributor(createNotesSyncContributor(notesFiles));

    ctx.registerTickerResearchTab({
      id: "notes",
      name: "Notes",
      order: 50,
      component: NotesTab,
    });

    ctx.registerPane({
      id: "quick-notes",
      name: "Notes",
      icon: "N",
      component: QuickNotesPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 60, height: 20 },
    });

    ctx.registerPaneTemplate({
      id: "new-quick-notes-pane",
      paneId: "quick-notes",
      label: "Notes",
      description: "Open a general-purpose notes scratchpad",
      keywords: ["notes", "quick", "scratchpad", "memo"],
      shortcut: { prefix: "NOTE" },
      createInstance: () => ({ placement: "floating" }),
    });
  },
};
