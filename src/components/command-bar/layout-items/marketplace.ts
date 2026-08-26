import { requestAuthDialog } from "../../../plugins/builtin/cloud/auth-dialog";
import type { ResultItem } from "../list/model";
import type { LayoutItemsContext } from "./types";

function authorLabel(author: { username: string | null; displayName: string }): string {
  return author.username ? `@${author.username}` : author.displayName;
}

function requestLogin(context: LayoutItemsContext): void {
  if (!requestAuthDialog({ mode: "login" })) {
    context.pluginRegistry.notify({ body: "Open Account Management to log in.", type: "info" });
  }
}

export function buildPublishLayoutItem(context: LayoutItemsContext): ResultItem {
  const { currentLayout, marketplace, openInlineConfirm, pluginRegistry, state } = context;
  const currentName = state.config.layouts[state.config.activeLayoutIndex]?.name || "Community Layout";
  const signedOut = marketplace.state.status === "signed-out";
  return {
    id: "layout-marketplace-publish",
    label: "Publish Current Layout",
    detail: signedOut
      ? "Log in to publish this arrangement"
      : "Share the pane arrangement as an editable community layout",
    category: "Your Layouts",
    kind: "action",
    action: signedOut
      ? () => requestLogin(context)
      : () => openInlineConfirm({
        confirmId: "layout-marketplace-publish",
        title: "Publish Current Layout",
        body: [
          `Publish “${currentName}” to Discover?`,
          "Pane arrangement, pane types, and fixed tickers will be public.",
          "Settings, pane state, accounts, portfolios, and broker data are excluded.",
        ],
        confirmLabel: "Publish Layout",
        cancelLabel: "Back",
        tone: "default",
        onConfirm: async () => {
          await marketplace.publish(currentName, currentLayout);
          pluginRegistry.notify({ body: `Layout “${currentName}” published`, type: "success" });
        },
      }),
  };
}

export function buildDiscoverLayoutItems(context: LayoutItemsContext): ResultItem[] {
  const { marketplace, openInlineConfirm, dispatch, pluginRegistry } = context;
  if (marketplace.state.status === "signed-out") {
    return [{
      id: "layout-marketplace-login",
      label: "Log in to discover layouts",
      detail: "A Gloom account is required to browse community layouts",
      category: "Discover",
      kind: "action",
      action: () => requestLogin(context),
    }];
  }
  if (marketplace.state.status === "idle" || marketplace.state.status === "loading") {
    return [{
      id: "layout-marketplace-loading",
      label: "Loading community layouts…",
      detail: "Fetching the newest published arrangements",
      category: "Discover",
      kind: "info",
      disabled: true,
      defaultSelectable: false,
      action: () => {},
    }];
  }
  if (marketplace.state.status === "error") {
    return [{
      id: "layout-marketplace-retry",
      label: "Retry Discover",
      detail: marketplace.state.error,
      category: "Discover",
      kind: "action",
      action: marketplace.refresh,
    }];
  }
  if (marketplace.state.items.length === 0) {
    return [{
      id: "layout-marketplace-empty",
      label: "No community layouts yet",
      detail: "Publish your current layout to start Discover",
      category: "Discover",
      kind: "info",
      disabled: true,
      defaultSelectable: false,
      action: () => {},
    }];
  }

  return marketplace.state.items.map((entry): ResultItem => {
    const missingPanes = [...new Set(entry.layout.instances
      .map((instance) => instance.paneId)
      .filter((paneId) => !pluginRegistry.panes.has(paneId)))];
    const author = authorLabel(entry.author);
    const paneCount = entry.layout.instances.length;
    return {
      id: `layout-marketplace:${entry.id}`,
      label: entry.name,
      detail: `${author} · ${paneCount} ${paneCount === 1 ? "pane" : "panes"}${missingPanes.length > 0 ? ` · ${missingPanes.length} unavailable` : ""}`,
      right: author,
      category: "Discover",
      kind: "action",
      previewLayout: entry.layout,
      searchText: `${author} ${entry.layout.instances.map((instance) => instance.paneId).join(" ")}`,
      action: () => openInlineConfirm({
        confirmId: `layout-marketplace-install:${entry.id}`,
        title: entry.name,
        body: [
          `Published by ${author}.`,
          `Add ${paneCount} ${paneCount === 1 ? "pane" : "panes"} as a new editable layout?`,
          ...(missingPanes.length > 0
            ? [`${missingPanes.length} pane ${missingPanes.length === 1 ? "type is" : "types are"} unavailable here and will stay hidden.`]
            : []),
        ],
        confirmLabel: "Add Layout",
        cancelLabel: "Back",
        tone: "default",
        onConfirm: () => {
          dispatch({ type: "INSTALL_LAYOUT_COPY", name: entry.name, layout: entry.layout });
          pluginRegistry.notify({ body: `Layout “${entry.name}” added`, type: "success" });
        },
      }),
    };
  });
}
