import { DOCS_PANE_TEMPLATE_ID } from "../../../docs/content";
import { attachDocsPersistence, resetDocsPersistence } from "../../../docs/load";
import { docsTopicKey, type DocsTopic } from "../../../docs/topics";
import { findPaneInstance } from "../../../types/config";
import type { PaneTemplateContext, PaneTemplateCreateOptions } from "../../../types/plugin";
import { getSharedRegistry } from "../../registry";
import { buildRegistryHelpIndex } from "../help/function-index";
import type { PluginModule } from "../plugin-module";
import { DocsPane } from "./pane";
import { docsTopicForArgument, docsTopicForPane } from "./targets";

/** One reader: every request lands in the same pane, on top of its history. */
const DOCS_INSTANCE_ID = "docs";

function requestedTopic(context: PaneTemplateContext, options?: PaneTemplateCreateOptions): DocsTopic {
  const registry = getSharedRegistry();
  // The command line (`gloom fn DOCS RV`) has no registry: the argument goes to the reader as a search.
  const index = registry ? buildRegistryHelpIndex(registry) : null;
  const paneId = options?.values?.pane;
  if (paneId && registry && index) {
    const instance = findPaneInstance(context.layout, paneId);
    return (instance ? docsTopicForPane(index, registry, instance) : null) ?? { kind: "home" };
  }
  return docsTopicForArgument(index, options?.arg ?? options?.values?.topic ?? "");
}

export const docsModule: PluginModule = {
  setup(ctx) {
    attachDocsPersistence(ctx.persistence);
  },

  dispose() {
    resetDocsPersistence();
  },

  panes: [
    {
      id: "docs",
      name: "Docs",
      icon: "?",
      component: DocsPane,
      reportFreshness: { status: "not-a-feed", basis: "documentation" },
      // A page reads whole in a report, not cut at the first screen.
      shotFitsReader: true,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 96, height: 34 },
    },
  ],

  paneTemplates: [
    {
      id: DOCS_PANE_TEMPLATE_ID,
      paneId: "docs",
      label: "Docs",
      description: "Read the docs and Academy lessons in the app: search them, or open a function's entry.",
      keywords: ["docs", "documentation", "manual", "guide", "academy", "learn", "lesson", "what is"],
      shortcut: { prefix: "DOCS", argPlaceholder: "function", argKind: "text", argOptional: true },
      createInstance(context, options) {
        return {
          instanceId: DOCS_INSTANCE_ID,
          title: "Docs",
          placement: "floating",
          // `at` makes a repeat request for the same topic open it again.
          params: { topic: docsTopicKey(requestedTopic(context, options)), at: String(Date.now()) },
        };
      },
    },
  ],
};
