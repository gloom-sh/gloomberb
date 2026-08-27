import { useCallback, useMemo, useState } from "react";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { useShortcut } from "../react/input";
import { useAppDispatch, useAppSelector } from "../state/app/context";
import { selectActiveLayoutIndex, selectSavedLayouts } from "../state/selectors-ui";
import { useDialog, useDialogState, type PromptContext } from "../ui/dialog";
import { useRendererHost, useUiHost } from "../ui";
import { requestAuthDialog } from "../plugins/builtin/cloud/auth-dialog";
import { usePlanAccess } from "../plugins/builtin/shared/plan-access";
import type { PluginRegistry } from "../plugins/registry";
import type { LayoutConfig } from "../types/config";
import type {
  DesktopLayoutMarketplaceAction,
  DesktopWindowBridge,
} from "../types/desktop-window";
import { LayoutGalleryDesktop } from "./gallery-desktop";
import { LayoutGalleryTerminal } from "./gallery-terminal";
import { LayoutNameDialog } from "./name-dialog";
import {
  buildCommunityEntries,
  buildOwnedEntries,
  filterGalleryEntries,
  missingPaneIds,
  type GalleryEntry,
} from "./model";
import { useLayoutMarketplace } from "./use-marketplace";

export interface LayoutGalleryController {
  query: string;
  setQuery: (query: string) => void;
  owned: GalleryEntry[];
  community: GalleryEntry[];
  /** Owned entries first, then community, in the order the destination renders them. */
  entries: GalleryEntry[];
  selectedId: string | null;
  select: (id: string | null) => void;
  detail: GalleryEntry | null;
  openDetail: (entry: GalleryEntry) => void;
  closeDetail: () => void;
  activate: (entry: GalleryEntry) => void;
  install: (entry: GalleryEntry) => void;
  discover: ReturnType<typeof useLayoutMarketplace>;
  signedIn: boolean;
  requestSignIn: () => void;
  publishCurrent: () => void;
  publishing: boolean;
  newLayout: () => void;
  renameLayout: (entry: GalleryEntry) => void;
  duplicateLayout: (entry: GalleryEntry) => void;
  deleteLayout: (entry: GalleryEntry) => void;
  canDelete: boolean;
  close: () => void;
  panes: PluginRegistry["panes"];
  missingPaneIds: (layout: LayoutConfig) => string[];
}

export function LayoutMarketplaceGallery({
  pluginRegistry,
  desktopWindowBridge,
}: {
  pluginRegistry: PluginRegistry;
  desktopWindowBridge?: DesktopWindowBridge;
}) {
  const dispatch = useAppDispatch();
  const rendererHost = useRendererHost();
  const windowed = desktopWindowBridge?.kind === "marketplace";
  const dialog = useDialog();
  const dialogOpen = useDialogState((state) => state.isOpen);
  const layouts = useAppSelector(selectSavedLayouts);
  const activeIndex = useAppSelector(selectActiveLayoutIndex);
  const currentLayout = useAppSelector((state) => state.config.layout);
  const { signedIn } = usePlanAccess();
  const discover = useLayoutMarketplace(true, signedIn);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  const panes = pluginRegistry.panes;
  const owned = useMemo(
    () => filterGalleryEntries(buildOwnedEntries(layouts, activeIndex), query, panes),
    [activeIndex, layouts, panes, query],
  );
  const community = useMemo(
    () => filterGalleryEntries(buildCommunityEntries(discover.state.items), query, panes),
    [discover.state.items, panes, query],
  );
  const entries = useMemo(() => [...owned, ...community], [community, owned]);
  const detail = useMemo(
    () => entries.find((entry) => entry.id === detailId) ?? null,
    [detailId, entries],
  );

  const close = useCallback(() => {
    if (windowed && rendererHost.controlWindow) {
      void rendererHost.controlWindow("close");
      return;
    }
    dispatch({ type: "SET_LAYOUT_MARKETPLACE", open: false });
  }, [dispatch, rendererHost, windowed]);

  const performLayoutAction = useCallback(async (action: DesktopLayoutMarketplaceAction) => {
    if (windowed && desktopWindowBridge.performLayoutMarketplaceAction) {
      await desktopWindowBridge.performLayoutMarketplaceAction(action);
      return;
    }
    dispatch(action);
  }, [desktopWindowBridge, dispatch, windowed]);

  const reportLayoutActionError = useCallback((error: unknown) => {
    pluginRegistry.notify({
      body: error instanceof Error ? error.message : "Could not update layouts.",
      type: "error",
    });
  }, [pluginRegistry]);

  const activate = useCallback((entry: GalleryEntry) => {
    if (entry.kind === "community") {
      setDetailId(entry.id);
      setSelectedId(entry.id);
      return;
    }
    if (entry.index !== null && entry.index !== activeIndex) {
      void performLayoutAction({ type: "SWITCH_LAYOUT", index: entry.index })
        .catch(reportLayoutActionError);
    }
    if (!windowed) close();
  }, [activeIndex, close, performLayoutAction, reportLayoutActionError, windowed]);

  const install = useCallback((entry: GalleryEntry) => {
    void performLayoutAction({ type: "INSTALL_LAYOUT_COPY", name: entry.name, layout: entry.layout })
      .then(() => {
        pluginRegistry.notify({ body: `Layout "${entry.name}" added`, type: "success" });
        if (!windowed) close();
      })
      .catch(reportLayoutActionError);
  }, [close, performLayoutAction, pluginRegistry, reportLayoutActionError, windowed]);

  const requestSignIn = useCallback(() => {
    if (!requestAuthDialog({ mode: "login" })) {
      pluginRegistry.notify({ body: "Open Account Management to log in.", type: "info" });
    }
  }, [pluginRegistry]);

  const promptName = useCallback(async (options: {
    title: string;
    label: string;
    confirmLabel: string;
    initialValue?: string;
  }) => {
    const name = await dialog.prompt<string | undefined>({
      closeOnClickOutside: true,
      content: (context: unknown) => (
        <LayoutNameDialog
          {...(context as PromptContext<string | undefined>)}
          title={options.title}
          label={options.label}
          confirmLabel={options.confirmLabel}
          initialValue={options.initialValue ?? ""}
        />
      ),
    }).catch(() => undefined);
    return typeof name === "string" ? name.trim() : "";
  }, [dialog]);

  const newLayout = useCallback(async () => {
    const name = await promptName({
      title: "New Layout",
      label: "Layout name",
      confirmLabel: "Create Layout",
    });
    if (!name) return;
    try {
      await performLayoutAction({ type: "NEW_LAYOUT", name });
      pluginRegistry.notify({ body: `Layout "${name}" created`, type: "success" });
      if (!windowed) close();
    } catch (error) {
      reportLayoutActionError(error);
    }
  }, [close, performLayoutAction, pluginRegistry, promptName, reportLayoutActionError, windowed]);

  const renameLayout = useCallback(async (entry: GalleryEntry) => {
    if (entry.index === null) return;
    const name = await promptName({
      title: "Rename Layout",
      label: "New name",
      confirmLabel: "Rename Layout",
      initialValue: entry.name,
    });
    if (!name || name === entry.name) return;
    try {
      await performLayoutAction({ type: "RENAME_LAYOUT", index: entry.index, name });
    } catch (error) {
      reportLayoutActionError(error);
    }
  }, [performLayoutAction, promptName, reportLayoutActionError]);

  const duplicateLayout = useCallback((entry: GalleryEntry) => {
    if (entry.index === null) return;
    void performLayoutAction({ type: "DUPLICATE_LAYOUT", index: entry.index })
      .then(() => {
        pluginRegistry.notify({ body: `Layout "${entry.name}" duplicated`, type: "success" });
        if (!windowed) close();
      })
      .catch(reportLayoutActionError);
  }, [close, performLayoutAction, pluginRegistry, reportLayoutActionError, windowed]);

  const deleteLayout = useCallback(async (entry: GalleryEntry) => {
    if (entry.index === null || layouts.length <= 1) return;
    const confirmed = await dialog.prompt<boolean>({
      closeOnClickOutside: true,
      content: (context: unknown) => (
        <ConfirmDialog
          {...(context as PromptContext<boolean>)}
          title="Delete Layout"
          body={[`Delete layout "${entry.name}"? This cannot be undone.`]}
          confirmLabel="Delete Layout"
          cancelLabel="Cancel"
          width={48}
        />
      ),
    }).catch(() => false);
    if (confirmed !== true) return;
    try {
      await performLayoutAction({ type: "DELETE_LAYOUT", index: entry.index });
      pluginRegistry.notify({ body: `Layout "${entry.name}" deleted`, type: "success" });
    } catch (error) {
      reportLayoutActionError(error);
    }
  }, [dialog, layouts.length, performLayoutAction, pluginRegistry, reportLayoutActionError]);

  const publishCurrent = useCallback(async () => {
    if (!signedIn) {
      requestSignIn();
      return;
    }
    const name = layouts[activeIndex]?.name || "Community Layout";
    const confirmed = await dialog.prompt<boolean>({
      closeOnClickOutside: true,
      content: (context: unknown) => (
        <ConfirmDialog
          {...(context as PromptContext<boolean>)}
          title="Publish Current Layout"
          body={[
            `Publish "${name}" to Discover?`,
            "Pane arrangement, pane types, and fixed tickers will be public.",
            "Settings, pane state, accounts, portfolios, and broker data are excluded.",
          ]}
          confirmLabel="Publish Layout"
          cancelLabel="Cancel"
          confirmVariant="primary"
          width={52}
        />
      ),
    }).catch(() => false);
    if (confirmed !== true) return;
    setPublishing(true);
    try {
      await discover.publish(name, currentLayout);
      pluginRegistry.notify({ body: `Layout "${name}" published`, type: "success" });
    } catch (error) {
      pluginRegistry.notify({
        body: error instanceof Error ? error.message : "Could not publish this layout.",
        type: "error",
      });
    } finally {
      setPublishing(false);
    }
  }, [activeIndex, currentLayout, dialog, discover, layouts, pluginRegistry, requestSignIn, signedIn]);

  useShortcut((event) => {
    if (event.name !== "escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (detailId) setDetailId(null);
    else close();
  }, { enabled: !dialogOpen, phase: "before", allowEditable: true, scope: "layout-gallery" });

  const controller: LayoutGalleryController = {
    query,
    setQuery,
    owned,
    community,
    entries,
    selectedId,
    select: setSelectedId,
    detail,
    openDetail: (entry) => {
      setSelectedId(entry.id);
      setDetailId(entry.id);
    },
    closeDetail: () => setDetailId(null),
    activate,
    install,
    discover,
    signedIn,
    requestSignIn,
    publishCurrent,
    publishing,
    newLayout,
    renameLayout,
    duplicateLayout,
    deleteLayout,
    canDelete: layouts.length > 1,
    close,
    panes,
    missingPaneIds: (layout) => missingPaneIds(layout, panes),
  };

  return useUiHost().kind === "desktop-web"
    ? <LayoutGalleryDesktop controller={controller} />
    : <LayoutGalleryTerminal controller={controller} dialogOpen={dialogOpen} />;
}
