import { apiClient } from "../../../api-client";
import type { GloomPlugin } from "../../../types/plugin";
import { teamStore } from "../cloud/team/store";
import { exportNotesToDirectory, exportSourceLabel } from "./export";
import { NotesFiles } from "./files";
import { migrateLocalNotes, notesMigratedAt } from "./migration";
import { createQuickNotesPane } from "./quick-notes-pane";
import { NotesStoreRegistry } from "./store";
import { createNotesTab } from "./ticker-notes-tab";

let disposeNotes: (() => void) | null = null;

export const notesPlugin: GloomPlugin = {
  id: "notes",
  name: "Notes",
  version: "2.0.0",
  description: "Markdown notes on tickers and on their own, personal or shared with a team.",
  toggleable: true,

  setup(ctx) {
    const dataDir = ctx.getConfig().dataDir;
    const notesFiles = new NotesFiles(dataDir);
    const registry = new NotesStoreRegistry({
      persistence: ctx.persistence,
      files: notesFiles,
      isSignedIn: () => apiClient.isVerified(),
    });
    const NotesTab = createNotesTab(registry);
    const QuickNotesPane = createQuickNotesPane(registry);
    let migrating = false;

    // First signed-in launch: the .md files on disk go up, then stay on disk
    // as the export format. Older cloud copies never overwrite newer files.
    const migrate = async () => {
      if (migrating || !apiClient.isVerified() || notesMigratedAt(ctx.persistence)) return;
      const cloud = registry.cloud({ kind: "user" });
      if (!cloud) return;
      migrating = true;
      try {
        const result = await migrateLocalNotes(notesFiles, cloud, ctx.persistence);
        if (result && result.uploaded > 0) {
          ctx.notify({
            body: `${result.uploaded} local ${result.uploaded === 1 ? "note" : "notes"} imported to Gloom Cloud. The files stay on disk.`,
            type: "success",
          });
        }
      } catch (error) {
        ctx.log.error("Local note import failed", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        migrating = false;
      }
    };
    void migrate();
    const disposers = [
      apiClient.subscribeCurrentUser(() => {
        registry.invalidateAll();
        void migrate();
      }),
      // A teammate's edit invalidates the cached copy so the next open is fresh.
      apiClient.subscribeCloudEvent("note.updated", () => registry.invalidateAll()),
      apiClient.subscribeCloudEvent("note.deleted", () => registry.invalidateAll()),
    ];

    ctx.on("ticker:removed", ({ symbol }) => {
      registry.personal().delete(symbol).catch((error) => {
        ctx.log.error("Failed to delete ticker note", { symbol, error: error instanceof Error ? error.message : String(error) });
        ctx.notify({ body: "Failed to delete note.", type: "error" });
      });
    });

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

    ctx.registerCommand({
      id: "notes-export",
      label: "Export Notes",
      description: "Write every note, yours and your teams', as Markdown files",
      keywords: ["notes", "export", "markdown", "backup"],
      category: "data",
      execute: async () => {
        const stamp = new Date().toISOString().slice(0, 10);
        const dir = `${dataDir}/notes-export-${stamp}`;
        const teams = teamStore.getSnapshot().teams;
        const sources = [
          { label: exportSourceLabel(registry.personal()), store: registry.personal() },
          ...teams.map((team) => ({ label: exportSourceLabel(registry.forOwner({ kind: "team", teamId: team.id }), team.name), store: registry.forOwner({ kind: "team", teamId: team.id }) })),
        ];
        try {
          const result = await exportNotesToDirectory(dir, sources);
          ctx.notify({ body: `Exported ${result.files} ${result.files === 1 ? "note" : "notes"} to ${result.dir}`, type: "success" });
        } catch (error) {
          ctx.notify({ body: error instanceof Error ? error.message : "Could not export notes.", type: "error" });
        }
      },
    });

    disposeNotes = () => {
      for (const dispose of disposers) dispose();
    };
  },

  dispose() {
    disposeNotes?.();
    disposeNotes = null;
  },
};
