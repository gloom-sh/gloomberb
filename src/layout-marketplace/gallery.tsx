import { useCallback, useMemo, useState } from "react";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { useShortcut } from "../react/input";
import { useAppDispatch, useAppSelector } from "../state/app/context";
import { selectActiveLayoutIndex, selectSavedLayouts } from "../state/selectors-ui";
import { useDialog, useDialogState, type PromptContext } from "../ui/dialog";
import { useUiHost } from "../ui";
import { requestAuthDialog } from "../plugins/builtin/cloud/auth-dialog";
import { usePlanAccess } from "../plugins/builtin/shared/plan-access";
import type { PluginRegistry } from "../plugins/registry";
import type { LayoutConfig } from "../types/config";
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
  focused = true,
  width,
  height,
  onClose,
}: {
  pluginRegistry: PluginRegistry;
  focused?: boolean;
  width?: number;
  height?: number;
  onClose?: () => void;
}) {
  const dispatch = useAppDispatch();
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
    if (onClose) onClose();
    else pluginRegistry.hidePane("layout-marketplace");
  }, [onClose, pluginRegistry]);

  const activate = useCallback((entry: GalleryEntry) => {
    if (entry.kind === "community") {
      setDetailId(entry.id);
      setSelectedId(entry.id);
      return;
    }
    close();
    if (entry.index !== null && entry.index !== activeIndex) {
      dispatch({ type: "SWITCH_LAYOUT", index: entry.index });
    }
  }, [activeIndex, close, dispatch]);

  const install = useCallback((entry: GalleryEntry) => {
    close();
    dispatch({ type: "INSTALL_LAYOUT_COPY", name: entry.name, layout: entry.layout });
    pluginRegistry.notify({ body: `Layout "${entry.name}" added`, type: "success" });
  }, [close, dispatch, pluginRegistry]);

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
    close();
    dispatch({ type: "NEW_LAYOUT", name });
    pluginRegistry.notify({ body: `Layout "${name}" created`, type: "success" });
  }, [close, dispatch, pluginRegistry, promptName]);

  const renameLayout = useCallback(async (entry: GalleryEntry) => {
    if (entry.index === null) return;
    const name = await promptName({
      title: "Rename Layout",
      label: "New name",
      confirmLabel: "Rename Layout",
      initialValue: entry.name,
    });
    if (!name || name === entry.name) return;
    dispatch({ type: "RENAME_LAYOUT", index: entry.index, name });
  }, [dispatch, promptName]);

  const duplicateLayout = useCallback((entry: GalleryEntry) => {
    if (entry.index === null) return;
    close();
    dispatch({ type: "DUPLICATE_LAYOUT", index: entry.index });
    pluginRegistry.notify({ body: `Layout "${entry.name}" duplicated`, type: "success" });
  }, [close, dispatch, pluginRegistry]);

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
    dispatch({ type: "DELETE_LAYOUT", index: entry.index });
    pluginRegistry.notify({ body: `Layout "${entry.name}" deleted`, type: "success" });
  }, [dialog, dispatch, layouts.length, pluginRegistry]);

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
  }, { enabled: focused && !dialogOpen, phase: "before", allowEditable: true, scope: "layout-gallery" });

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
    ? (
      <LayoutGalleryDesktop
        controller={controller}
        focused={focused}
        width={width}
        height={height}
      />
    )
    : (
      <LayoutGalleryTerminal
        controller={controller}
        dialogOpen={dialogOpen}
        focused={focused}
        width={width}
        height={height}
      />
    );
}
