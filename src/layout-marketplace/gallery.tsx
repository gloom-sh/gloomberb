import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePaneFooter, type PaneHint } from "../components/layout/pane/footer";
import { ChoiceDialog } from "../components/ui/choice-dialog";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { useShortcut } from "../react/input";
import { isPlainKey } from "../utils/keyboard";
import { useAppDispatch, useAppSelector } from "../state/app/context";
import { useDialog, useDialogState, type PromptContext } from "../ui/dialog";
import { useRendererHost, useUiHost } from "../ui";
import { apiClient, type TeamSummary } from "../api-client";
import { requestAuthDialog } from "../plugins/builtin/cloud/auth-dialog";
import { teamStore } from "../plugins/builtin/cloud/team/store";
import { usePlanAccess } from "../plugins/builtin/shared/plan-access";
import { getMarketplaceHost } from "../plugins/builtin/plugin-marketplace/store";
import { rememberLayoutRequirements } from "../components/layout/missing-pane";
import type { PluginRegistry } from "../plugins/registry";
import type { LayoutConfig } from "../types/config";
import { LayoutGalleryDesktop } from "./gallery-desktop";
import { LayoutGalleryTerminal } from "./gallery-terminal";
import { LayoutNameDialog } from "./name-dialog";
import {
  buildCommunityEntries,
  buildOwnedEntries,
  buildTeamEntries,
  filterGalleryEntries,
  missingPaneIds,
  resolvePreviewEntry,
  type GalleryEntry,
} from "./model";
import { computeLayoutRequirements, LayoutRevisionConflictError, type CloudLayoutEntry } from "./cloud";
import { linkedLayoutUpdates, originFromEntry } from "./linked";
import { publicMarketplaceLayoutUrl } from "./api";
import {
  materializeMarketplaceLayout,
  publishableMarketplaceLayout,
} from "./payload";
import { useLayoutMarketplace, useTeamLayouts } from "./use-marketplace";

export interface LayoutGalleryController {
  query: string;
  setQuery: (query: string) => void;
  owned: GalleryEntry[];
  community: GalleryEntry[];
  /** One section per team the account is in, in team name order. */
  teamSections: Array<{ team: TeamSummary; entries: GalleryEntry[] }>;
  teamLayouts: ReturnType<typeof useTeamLayouts>;
  /** Owned entries first, then team, then community, in the order the destination renders them. */
  entries: GalleryEntry[];
  /** Publish the current tab to a team (new layout), or push a revision when it is linked. */
  publishToTeam: (entry: GalleryEntry) => void;
  pullTeamUpdates: (entry: GalleryEntry) => void;
  unlink: (entry: GalleryEntry) => void;
  teams: TeamSummary[];
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
  requestSignUp: () => void;
  publishCurrent: () => void;
  copyLink: (entry: GalleryEntry) => void;
  publishing: boolean;
  newLayout: () => void;
  renameLayout: (entry: GalleryEntry) => void;
  duplicateLayout: (entry: GalleryEntry) => void;
  deleteLayout: (entry: GalleryEntry) => void;
  canDelete: boolean;
  /** Saved layouts in total, filtered or not, so a move knows the last position. */
  layoutCount: number;
  /** Moves an owned layout one place, which is also its tab and its Cmd/Ctrl+digit. */
  moveLayout: (entry: GalleryEntry, delta: -1 | 1) => void;
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
  const renderer = useRendererHost();
  const dialogOpen = useDialogState((state) => state.isOpen);
  const layouts = useAppSelector((state) => state.config.layouts);
  const activeIndex = useAppSelector((state) => state.config.activeLayoutIndex);
  const currentLayout = useAppSelector((state) => state.config.layout);
  const currentPaneState = useAppSelector((state) => state.paneState);
  const { signedIn } = usePlanAccess();
  const discover = useLayoutMarketplace(true, signedIn);
  const teamSnapshot = useSyncExternalStore(
    (onChange) => teamStore.subscribe(onChange),
    () => teamStore.getSnapshot(),
  );
  const teams = teamSnapshot.teams;
  const teamLayouts = useTeamLayouts(signedIn, teams);
  const remoteRevisions = useSyncExternalStore(
    (onChange) => linkedLayoutUpdates.subscribe(onChange),
    () => linkedLayoutUpdates.snapshot(),
  );
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  const panes = pluginRegistry.panes;
  const owned = useMemo(
    () => filterGalleryEntries(buildOwnedEntries(layouts, activeIndex, { panes, teams, remoteRevisions }), query, panes),
    [activeIndex, layouts, panes, query, remoteRevisions, teams],
  );
  const community = useMemo(
    () => filterGalleryEntries(buildCommunityEntries(discover.state.items), query, panes),
    [discover.state.items, panes, query],
  );
  const teamEntries = useMemo(
    () => filterGalleryEntries(buildTeamEntries(teamLayouts.state.items, teams, layouts), query, panes),
    [layouts, panes, query, teamLayouts.state.items, teams],
  );
  const teamSections = useMemo(
    () => teams.map((team) => ({ team, entries: teamEntries.filter((entry) => entry.team?.id === team.id) })),
    [teamEntries, teams],
  );
  const entries = useMemo(() => [...owned, ...teamEntries, ...community], [community, owned, teamEntries]);
  const detail = useMemo(
    () => entries.find((entry) => entry.id === detailId) ?? null,
    [detailId, entries],
  );

  const close = useCallback(() => {
    if (onClose) onClose();
    else pluginRegistry.hidePane("layout-marketplace");
  }, [onClose, pluginRegistry]);

  // A new search puts the cursor back on its best match.
  const changeQuery = useCallback((next: string) => {
    if (next === query) return;
    setQuery(next);
    setSelectedId(null);
  }, [query]);

  const activate = useCallback((entry: GalleryEntry) => {
    if (entry.kind === "community" || (entry.kind === "team" && entry.index === null)) {
      setDetailId(entry.id);
      setSelectedId(entry.id);
      return;
    }
    close();
    if (entry.index !== null && entry.index !== activeIndex) {
      dispatch({ type: "SWITCH_LAYOUT", index: entry.index });
    }
  }, [activeIndex, close, dispatch]);


  const requestSignIn = useCallback(() => {
    if (!requestAuthDialog({ mode: "login" })) {
      pluginRegistry.notify({ body: "Open Account Management to log in.", type: "info" });
    }
  }, [pluginRegistry]);

  const requestSignUp = useCallback(() => {
    if (!requestAuthDialog({ mode: "signup" })) {
      pluginRegistry.notify({ body: "Open Account Management to sign up.", type: "info" });
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

  const teamEntryFor = useCallback((entry: GalleryEntry): CloudLayoutEntry | null => (
    entry.marketplaceId
      ? teamLayouts.state.items.find((item) => item.id === entry.marketplaceId) ?? null
      : null
  ), [teamLayouts.state.items]);


  const install = useCallback((entry: GalleryEntry) => {
    // A team layout that is already open as a tab: go there instead of a copy.
    if (entry.kind === "team" && entry.index !== null) {
      activate(entry);
      return;
    }
    const cloud = entry.kind === "team" ? teamEntryFor(entry) : null;
    const origin = cloud ? originFromEntry(cloud) : null;
    if (cloud) rememberLayoutRequirements(cloud.id, cloud.requires);
    const installed = materializeMarketplaceLayout(entry);
    close();
    dispatch({
      type: "INSTALL_LAYOUT_COPY",
      name: entry.name,
      layout: installed.layout,
      paneState: installed.paneState,
      ...(origin ? { origin } : {}),
    });
    pluginRegistry.notify({
      body: origin ? `Opened "${entry.name}" from ${entry.team?.name ?? "the team"}` : `Layout "${entry.name}" added`,
      type: "success",
    });
  }, [activate, close, dispatch, pluginRegistry, teamEntryFor]);

  const requirementsFor = useCallback((layout: LayoutConfig) => {
    const installed = new Map((getMarketplaceHost()?.listInstalled() ?? []).map((plugin) => [plugin.id, plugin]));
    return computeLayoutRequirements(layout, {
      panePluginId: (paneId) => pluginRegistry.getPanePluginId(paneId),
      pluginInfo: (pluginId) => {
        const plugin = pluginRegistry.allPlugins.get(pluginId);
        const meta = installed.get(pluginId);
        if (!plugin) return null;
        const homepage = plugin.homepage ?? "";
        const github = /github\.com\/([^/]+\/[^/#?]+)/.exec(homepage);
        return {
          builtin: meta ? meta.source === "builtin" : true,
          version: plugin.version,
          ...(github?.[1] ? { repo: github[1].replace(/\.git$/, "") } : {}),
        };
      },
    });
  }, [pluginRegistry]);

  const chooseTeam = useCallback(async (): Promise<TeamSummary | null> => {
    if (teams.length === 0) {
      pluginRegistry.notify({ body: "Join or create a team first with TEAM.", type: "info" });
      return null;
    }
    if (teams.length === 1) return teams[0]!;
    const defaultId = teamStore.getDefaultTeamId();
    const id = await dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (context: unknown) => (
        <ChoiceDialog
          {...(context as PromptContext<string>)}
          title="Publish to which team?"
          choices={teams.map((team) => ({ id: team.id, label: `${team.shortName}· ${team.name}` }))}
          selectedChoiceId={defaultId ?? undefined}
        />
      ),
    }).catch(() => undefined);
    return teams.find((team) => team.id === id) ?? null;
  }, [dialog, pluginRegistry, teams]);

  const savedFor = useCallback((entry: GalleryEntry) => (entry.index !== null ? layouts[entry.index] ?? null : null), [layouts]);

  const contentFor = useCallback((entry: GalleryEntry) => {
    // The active tab's live state is the freshest copy of it.
    if (entry.index === activeIndex) return { layout: currentLayout, paneState: currentPaneState };
    const saved = savedFor(entry);
    return saved
      ? { layout: saved.layout, paneState: (saved.paneState ?? {}) as typeof currentPaneState }
      : { layout: entry.layout, paneState: entry.paneState };
  }, [activeIndex, currentLayout, currentPaneState, savedFor]);

  const pullTeamUpdates = useCallback(async (entry: GalleryEntry) => {
    const saved = savedFor(entry);
    const origin = saved?.origin;
    if (entry.index === null || !origin) return;
    setPublishing(true);
    try {
      const cloud = await apiClient.getCloudLayout(origin.layoutId);
      if (!cloud) {
        pluginRegistry.notify({ body: "This team layout no longer exists. The tab stays as a personal copy.", type: "info" });
        dispatch({ type: "SET_LAYOUT_ORIGIN", index: entry.index, origin: null });
        return;
      }
      const nextOrigin = originFromEntry(cloud);
      if (!nextOrigin) return;
      rememberLayoutRequirements(cloud.id, cloud.requires);
      const installed = materializeMarketplaceLayout(cloud);
      dispatch({
        type: "REPLACE_LAYOUT_CONTENT",
        index: entry.index,
        layout: installed.layout,
        paneState: installed.paneState,
        origin: nextOrigin,
        name: cloud.name,
      });
      teamLayouts.upsert(cloud);
      pluginRegistry.notify({ body: `Pulled "${cloud.name}" r${cloud.revision}`, type: "success" });
    } catch (error) {
      pluginRegistry.notify({ body: error instanceof Error ? error.message : "Could not pull the team layout.", type: "error" });
    } finally {
      setPublishing(false);
    }
  }, [dispatch, pluginRegistry, savedFor, teamLayouts]);

  const resolveConflict = useCallback(async (entry: GalleryEntry, remoteRevision: number): Promise<"copy" | "overwrite" | "discard" | null> => {
    const choice = await dialog.prompt<string>({
      closeOnClickOutside: false,
      content: (context: unknown) => (
        <ChoiceDialog
          {...(context as PromptContext<string>)}
          title={`${entry.team?.name ?? "The team"} published r${remoteRevision} since you pulled`}
          choices={[
            { id: "copy", label: "Save mine as a personal copy, then pull", description: "Keeps both. Your version becomes an unlinked tab." },
            { id: "overwrite", label: "Overwrite with mine", description: `Publishes your content as r${remoteRevision + 1}.` },
            { id: "discard", label: "Discard mine and pull", description: "Your local changes are lost." },
          ]}
          selectedChoiceId="copy"
        />
      ),
    }).catch(() => undefined);
    return choice === "copy" || choice === "overwrite" || choice === "discard" ? choice : null;
  }, [dialog]);

  const publishToTeam = useCallback(async (entry: GalleryEntry) => {
    if (!signedIn) {
      requestSignIn();
      return;
    }
    if (entry.index === null) return;
    const saved = savedFor(entry);
    const content = contentFor(entry);
    const payload = publishableMarketplaceLayout(content.layout, content.paneState, panes);
    const requires = requirementsFor(content.layout);
    const origin = saved?.origin;

    setPublishing(true);
    try {
      if (origin) {
        const publish = async (expectedRevision: number | undefined) => apiClient.publishLayoutRevision(origin.layoutId, payload, {
          expectedRevision,
          requires,
          name: entry.name,
        });
        let published: CloudLayoutEntry;
        try {
          published = await publish(origin.revision);
        } catch (error) {
          if (!(error instanceof LayoutRevisionConflictError)) throw error;
          const choice = await resolveConflict(entry, error.currentRevision);
          if (!choice) return;
          if (choice === "overwrite") {
            published = await publish(error.currentRevision);
          } else {
            if (choice === "copy") {
              dispatch({ type: "DUPLICATE_LAYOUT", index: entry.index });
              dispatch({ type: "SET_LAYOUT_ORIGIN", index: layouts.length, origin: null });
            }
            await pullTeamUpdates(entry);
            return;
          }
        }
        const nextOrigin = originFromEntry(published);
        if (nextOrigin) dispatch({ type: "SET_LAYOUT_ORIGIN", index: entry.index, origin: nextOrigin });
        teamLayouts.upsert(published);
        pluginRegistry.notify({ body: `Published "${published.name}" r${published.revision} to ${entry.team?.name ?? "the team"}`, type: "success" });
        return;
      }

      const team = await chooseTeam();
      if (!team) return;
      const name = await promptName({
        title: `Publish to ${team.name}`,
        label: "Layout name",
        confirmLabel: "Publish to team",
        initialValue: entry.name,
      });
      if (!name) return;
      const published = await apiClient.publishTeamLayout(team.id, name, payload, { requires });
      const nextOrigin = originFromEntry(published);
      if (nextOrigin) dispatch({ type: "SET_LAYOUT_ORIGIN", index: entry.index, origin: nextOrigin });
      if (name !== entry.name) dispatch({ type: "RENAME_LAYOUT", index: entry.index, name });
      teamLayouts.upsert(published);
      pluginRegistry.notify({ body: `Published "${name}" to ${team.name}. This tab is now linked.`, type: "success" });
    } catch (error) {
      pluginRegistry.notify({ body: error instanceof Error ? error.message : "Could not publish to the team.", type: "error" });
    } finally {
      setPublishing(false);
    }
  }, [chooseTeam, contentFor, dispatch, layouts.length, panes, pluginRegistry, promptName, pullTeamUpdates, requestSignIn, requirementsFor, resolveConflict, savedFor, signedIn, teamLayouts]);

  const unlink = useCallback((entry: GalleryEntry) => {
    if (entry.index === null || !savedFor(entry)?.origin) return;
    dispatch({ type: "SET_LAYOUT_ORIGIN", index: entry.index, origin: null });
    pluginRegistry.notify({ body: `"${entry.name}" is a personal layout now.`, type: "success" });
  }, [dispatch, pluginRegistry, savedFor]);

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

  const moveLayout = useCallback((entry: GalleryEntry, delta: -1 | 1) => {
    if (entry.index === null) return;
    const toIndex = entry.index + delta;
    if (toIndex < 0 || toIndex >= layouts.length) return;
    dispatch({ type: "REORDER_LAYOUT", fromIndex: entry.index, toIndex });
    // Owned ids follow the position, so the cursor moves with the layout.
    setSelectedId(`owned:${toIndex}`);
  }, [dispatch, layouts.length]);

  const copyLink = useCallback((entry: GalleryEntry) => {
    if (!entry.marketplaceId) return;
    void renderer.copyText(publicMarketplaceLayoutUrl(entry.marketplaceId)).then(() => {
      pluginRegistry.notify({ body: "Layout link copied", type: "success" });
    }).catch(() => {
      pluginRegistry.notify({ body: "Could not copy the layout link.", type: "error" });
    });
  }, [pluginRegistry, renderer]);

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
            "Pane setup, queries, chart views, drawings, and portable pane state will be public.",
            "Credentials, accounts, portfolios, and fields marked private are excluded.",
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
      const item = await discover.publish(
        name,
        publishableMarketplaceLayout(currentLayout, currentPaneState, panes),
      );
      try {
        await renderer.copyText(publicMarketplaceLayoutUrl(item.id));
        pluginRegistry.notify({ body: `Layout "${name}" published · link copied`, type: "success" });
      } catch {
        pluginRegistry.notify({ body: `Layout "${name}" published`, type: "success" });
      }
    } catch (error) {
      pluginRegistry.notify({
        body: error instanceof Error ? error.message : "Could not publish this layout.",
        type: "error",
      });
    } finally {
      setPublishing(false);
    }
  }, [activeIndex, currentLayout, currentPaneState, dialog, discover, layouts, panes, pluginRegistry, renderer, requestSignIn, signedIn]);

  const search = useGallerySearch();
  // Unscoped, like the view's keys: the pane menu opened over the gallery
  // takes Esc first and closes itself, not the gallery.
  useShortcut((event) => {
    if (event.name !== "escape") return;
    event.preventDefault();
    event.stopPropagation();
    // Leaving the search field is the first Escape, and it clears the search
    // as the kit search does; the gallery closes on the next.
    if (search.active) {
      changeQuery("");
      search.blur();
    } else if (detailId) setDetailId(null);
    else close();
  }, { enabled: focused && !dialogOpen, phase: "before", allowEditable: true });

  const controller: LayoutGalleryController = {
    query,
    setQuery: changeQuery,
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
    teamSections,
    teamLayouts,
    publishToTeam,
    pullTeamUpdates,
    unlink,
    teams,
    signedIn,
    requestSignIn,
    requestSignUp,
    publishCurrent,
    copyLink,
    publishing,
    newLayout,
    renameLayout,
    duplicateLayout,
    deleteLayout,
    canDelete: layouts.length > 1,
    layoutCount: layouts.length,
    moveLayout,
    close,
    panes,
    missingPaneIds: (layout) => missingPaneIds(layout, panes),
  };

  const desktop = useUiHost().kind === "desktop-web";
  // The desktop always previews something, so with no pick its actions follow
  // the layout in use; the terminal list always has an explicit row.
  const selected = desktop ? resolvePreviewEntry(controller) : controller.entries.find((entry) => entry.id === selectedId) ?? null;
  useLayoutGalleryActions({
    controller,
    selected,
    focused,
    dialogOpen,
    searchActive: search.active,
    focusSearch: search.focus,
  });

  return desktop
    ? (
      <LayoutGalleryDesktop
        controller={controller}
        search={search}
        focused={focused && !dialogOpen}
        width={width}
        height={height}
      />
    )
    : (
      <LayoutGalleryTerminal
        controller={controller}
        search={search}
        dialogOpen={dialogOpen}
        focused={focused}
        width={width}
        height={height}
      />
    );
}

/** The search field's focus, shared so the gallery's `/` reaches either renderer's field. */
export interface GallerySearchState {
  active: boolean;
  focusToken: number;
  focus: () => void;
  blur: () => void;
  setActive: (active: boolean) => void;
}

function useGallerySearch(): GallerySearchState {
  const [active, setActive] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const focus = useCallback(() => {
    setActive(true);
    setFocusToken((current) => current + 1);
  }, []);
  const blur = useCallback(() => setActive(false), []);
  return { active, focusToken, focus, blur, setActive };
}

/**
 * The gallery's actions, as footer hints and single keys, for both renderers.
 * They follow the selected entry: your own layouts open, rename, copy, delete,
 * move and sync with a team; a team layout opens as a linked tab; a community
 * layout is added as a copy or its link copied. The footer binds each hint's
 * key, and the pane menu lists them by their titles.
 */
function useLayoutGalleryActions({
  controller,
  selected,
  focused,
  dialogOpen,
  searchActive,
  focusSearch,
}: {
  controller: LayoutGalleryController;
  selected: GalleryEntry | null;
  focused: boolean;
  dialogOpen: boolean;
  searchActive: boolean;
  focusSearch: () => void;
}) {
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const withSelected = useCallback((action: (entry: GalleryEntry, gallery: LayoutGalleryController) => void) => () => {
    const entry = selectedRef.current;
    if (entry) action(entry, controllerRef.current);
  }, []);
  const open = useMemo(() => withSelected((entry, gallery) => {
    if (entry.kind === "owned") gallery.activate(entry);
    else gallery.install(entry);
  }), [withSelected]);
  const rename = useMemo(() => withSelected((entry, gallery) => {
    if (entry.kind === "owned") gallery.renameLayout(entry);
  }), [withSelected]);
  const copy = useMemo(() => withSelected((entry, gallery) => {
    if (entry.kind === "community") gallery.copyLink(entry);
    else if (entry.kind === "owned") gallery.duplicateLayout(entry);
  }), [withSelected]);
  const remove = useMemo(() => withSelected((entry, gallery) => {
    if (entry.kind === "owned" && gallery.canDelete) gallery.deleteLayout(entry);
  }), [withSelected]);
  const publishTeam = useMemo(() => withSelected((entry, gallery) => {
    if (entry.kind === "owned") gallery.publishToTeam(entry);
  }), [withSelected]);
  const pull = useMemo(() => withSelected((entry, gallery) => {
    if (entry.kind === "owned" && entry.linked?.updateAvailable) gallery.pullTeamUpdates(entry);
  }), [withSelected]);
  const unlink = useMemo(() => withSelected((entry, gallery) => {
    if (entry.kind === "owned" && entry.linked) gallery.unlink(entry);
  }), [withSelected]);
  const moveUp = useMemo(() => withSelected((entry, gallery) => {
    if (entry.kind === "owned") gallery.moveLayout(entry, -1);
  }), [withSelected]);
  const moveDown = useMemo(() => withSelected((entry, gallery) => {
    if (entry.kind === "owned") gallery.moveLayout(entry, 1);
  }), [withSelected]);

  const { canDelete, layoutCount, newLayout, publishCurrent, publishing } = controller;
  const teamsAvailable = controller.teamSections.length > 0;
  const kind = selected?.kind ?? null;
  const linked = selected?.kind === "owned" ? selected.linked ?? null : null;
  const openTab = selected?.kind === "team" && selected.index !== null;
  const ownedIndex = selected?.kind === "owned" ? selected.index : null;

  usePaneFooter("layout-marketplace", () => {
    const hints: PaneHint[] = [
      { id: "search", key: "/", label: "search", title: "Search Layouts", onPress: focusSearch },
      { id: "new", key: "n", label: "ew", title: "New Layout", onPress: newLayout },
    ];
    if (kind === "owned") {
      hints.push(
        { id: "open", key: "o", label: "pen", title: "Use Layout", onPress: open },
        // `r` refreshes every pane, so rename takes `e`.
        { id: "rename", key: "e", label: " rename", title: "Rename", onPress: rename },
        { id: "copy", key: "c", label: "opy", title: "Duplicate", onPress: copy },
        { id: "delete", key: "d", label: "elete", title: "Delete", onPress: remove, disabled: !canDelete },
      );
      if (teamsAvailable) {
        hints.push({
          id: "team",
          key: "t",
          label: linked ? "eam publish" : "eam",
          title: linked ? "Publish to Team" : "Publish to Team…",
          onPress: publishTeam,
          disabled: publishing,
        });
      }
      if (linked) {
        // `u` retries a failed app update, so pulling takes `g`.
        hints.push(
          {
            id: "pull",
            key: "g",
            label: linked.updateAvailable ? `et r${linked.updateAvailable}` : "et update",
            title: linked.updateAvailable ? `Pull r${linked.updateAvailable}` : "Pull",
            onPress: pull,
            disabled: publishing || !linked.updateAvailable,
          },
          { id: "unlink", key: "x", label: " unlink", title: "Unlink", onPress: unlink },
        );
      }
    } else if (kind === "team") {
      hints.push({
        id: "open-team",
        key: "a",
        label: openTab ? " open" : "dd linked tab",
        title: openTab ? "Open Tab" : "Open as Linked Tab",
        onPress: open,
      });
    } else if (kind === "community") {
      hints.push(
        { id: "add", key: "a", label: "dd layout", title: "Add Layout", onPress: open },
        { id: "copy-link", key: "c", label: "opy link", title: "Copy Link", onPress: copy },
      );
    }
    hints.push({ id: "publish", key: "p", label: "ublish", title: "Publish Current", onPress: publishCurrent, disabled: publishing });
    // Moving a layout moves its tab and its Cmd/Ctrl+digit. The keys are bound
    // and the pane menu lists them, but the footer is crowded already.
    const moves = ownedIndex === null ? [] : [
      { id: "move-up", key: "Shift+K", title: "Move Up", onPress: moveUp, disabled: ownedIndex <= 0 },
      { id: "move-down", key: "Shift+J", title: "Move Down", onPress: moveDown, disabled: ownedIndex >= layoutCount - 1 },
    ];
    return {
      info: publishing ? [{ id: "publishing", parts: [{ text: "publishing", tone: "muted" as const }] }] : [],
      hints,
      keys: moves.map((move): PaneHint => ({ ...move, label: "" })),
      menu: moves
        .filter((move) => !move.disabled)
        .map((move) => ({ id: `layout-gallery:${move.id}`, label: move.title, accelerator: move.key, onSelect: move.onPress })),
    };
  }, [canDelete, copy, focusSearch, kind, layoutCount, linked, moveDown, moveUp, newLayout, open, openTab, ownedIndex, publishCurrent, publishTeam, publishing, pull, remove, rename, teamsAvailable, unlink]);

  // The footer binds every hint's key; Enter, which has no hint, opens the entry.
  // Unscoped, so the pane menu opened over the gallery keeps its own Enter.
  useShortcut((event) => {
    if (event.targetEditable || searchActive) return;
    if (!isPlainKey(event, "enter", "return") || !selectedRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    open();
  }, { allowEditable: true, enabled: focused && !dialogOpen, phase: "before" });
}
