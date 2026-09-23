import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getPaneSidebarWidth,
  PaneSidebar,
  PaneSidebarRow,
} from "../components/layout/pane/sidebar";
import { ActionRow } from "../components/ui/action-row";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/display";
import { Spinner } from "../components/ui/loading";
import { QueryBar } from "../components/ui/query-bar";
import { EmptyState } from "../components/ui/status";
import { useShortcut } from "../react/input";
import { t, tf } from "../i18n";
import { useThemeColors } from "../theme/theme-context";
import { Box, ScrollBox, Text, TextAttributes, useUiCapabilities, type InputRenderable } from "../ui";
import { isPlainKey } from "../utils/keyboard";
import type { GallerySearchState, LayoutGalleryController } from "./gallery";
import { MiniWorkspace } from "./mini-workspace";
import {
  describeArrangement,
  formatPublishedAt,
  resolvePreviewEntry,
  summarizeLayoutPanes,
  type GalleryEntry,
} from "./model";

const PREVIEW = { width: 640, height: 320 };
const ELLIPSIS = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

/** A collapsible group header, the same row the chat sidebar uses. */
function SidebarSection({
  title,
  count,
  expanded,
  width,
  onToggle,
}: {
  title: string;
  count: number;
  expanded: boolean;
  width: number;
  onToggle: () => void;
}) {
  return (
    <Box height={1} width={width} flexDirection="row" flexShrink={0}>
      <ActionRow
        label={tf("{title} ({count})", { title: t(title), count: String(count) })}
        expanded={expanded}
        width={width}
        onPress={onToggle}
      />
    </Box>
  );
}

function SidebarNote({ children }: { children: ReactNode }) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="row" paddingX={1} paddingY={1} flexShrink={0}>
      <Text fg={colors.textDim} wrapText>{children}</Text>
    </Box>
  );
}

/** A state inside the sidebar with its own action (log in, retry). */
function SidebarState({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
      {children}
    </Box>
  );
}

function EntryRow({
  entry,
  controller,
  selected,
}: {
  entry: GalleryEntry;
  controller: LayoutGalleryController;
  selected: boolean;
}) {
  const colors = useThemeColors();
  const panes = summarizeLayoutPanes(entry.layout, controller.panes);
  const missing = panes.filter((pane) => pane.missing).length;
  const select = () => controller.select(entry.id);
  const activate = () => (entry.kind === "owned" ? controller.activate(entry) : controller.install(entry));

  return (
    <PaneSidebarRow
      active={selected}
      ariaLabel={tf("{name}, {panes} panes", { name: entry.name, panes: String(panes.length) })}
      onSelect={(event?: { detail?: number }) => {
        select();
        // A double click opens the layout, like Enter.
        if ((event?.detail ?? 0) >= 2) activate();
      }}
    >
      {({ foregroundColor, listWidth, onMouseDown }) => (
        <Box
          width={listWidth}
          height={1}
          minWidth={0}
          flexDirection="row"
          alignItems="center"
          role="button"
          tabIndex={0}
          aria-label={tf("{name}, {panes} panes", { name: entry.name, panes: String(panes.length) })}
          aria-current={selected ? "true" : undefined}
          data-gloom-role="layout-gallery-row"
          data-gloom-interactive="true"
          onMouseOver={select}
          onFocus={select}
          onMouseDown={onMouseDown}
          onKeyDown={(event: { key?: string; preventDefault?: () => void; stopPropagation?: () => void }) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault?.();
            event.stopPropagation?.();
            activate();
          }}
          style={{ cursor: "pointer" }}
        >
          <Text fg={entry.active ? colors.borderFocused : foregroundColor} selectable={false}>
            {entry.active ? " ● " : "   "}
          </Text>
          <Text
            fg={foregroundColor}
            attributes={entry.active ? TextAttributes.BOLD : 0}
            selectable={false}
            style={{ ...ELLIPSIS, minWidth: 0, flexShrink: 1 }}
          >
            {entry.name}
          </Text>
          <Box flexGrow={1} minWidth={0} />
          {missing > 0 && <Text fg={colors.warning}>!</Text>}
          <Text> </Text>
        </Box>
      )}
    </PaneSidebarRow>
  );
}

function DiscoverStatus({ controller }: { controller: LayoutGalleryController }) {
  const colors = useThemeColors();
  const { discover } = controller;

  if (!controller.signedIn) {
    return (
      <SidebarState>
        <EmptyState title="Log in to browse community layouts." />
        {/* The sidebar is narrow, so the pair wraps instead of running under the divider. */}
        <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
          <Button label={t("Log in")} variant="primary" compact onPress={controller.requestSignIn} />
          <Button label={t("Sign up free")} variant="secondary" compact onPress={controller.requestSignUp} />
        </Box>
      </SidebarState>
    );
  }
  if (discover.state.status === "loading" || discover.state.status === "idle") {
    return (
      <Box flexDirection="row" alignItems="center" paddingX={1} flexShrink={0}>
        <Spinner />
        <Text fg={colors.textDim}>{` ${t("Loading…")}`}</Text>
      </Box>
    );
  }
  if (discover.state.status === "error") {
    return (
      <SidebarState>
        <EmptyState
          title={discover.state.error}
          status="error"
          actions={<Button label={t("Retry")} compact onPress={discover.refresh} />}
        />
      </SidebarState>
    );
  }
  if (controller.community.length === 0) {
    return (
      <SidebarNote>
        {controller.query.trim()
          ? t("No community layouts match this search.")
          : t("No community layouts published yet.")}
      </SidebarNote>
    );
  }
  return null;
}

function TeamStatus({ controller }: { controller: LayoutGalleryController }) {
  const { state, refresh } = controller.teamLayouts;
  if (state.status === "loading") return <SidebarNote>{t("Loading team layouts…")}</SidebarNote>;
  if (state.status === "error") {
    return (
      <SidebarState>
        <EmptyState
          title={state.error}
          status="error"
          actions={<Button label={t("Retry")} compact onPress={refresh} />}
        />
      </SidebarState>
    );
  }
  return <SidebarNote>{t("No team layouts yet.")}</SidebarNote>;
}

function PreviewEmpty({ controller }: { controller: LayoutGalleryController }) {
  const colors = useThemeColors();
  const searching = controller.query.trim().length > 0;
  return (
    <Box
      flexGrow={1}
      alignItems="center"
      justifyContent="center"
      data-gloom-role="layout-gallery-preview-empty"
      padding={2}
    >
      <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
        {searching ? t("No layouts match this search.") : t("No layout selected.")}
      </Text>
    </Box>
  );
}

/**
 * The picked layout: its name, a badge when it is the one in use, what it is
 * and where it came from, then the arrangement. Its actions are the gallery's
 * footer hints and keys, which follow this selection.
 */
function PreviewPane({ controller, entry }: { controller: LayoutGalleryController; entry: GalleryEntry }) {
  const colors = useThemeColors();
  const linked = entry.kind === "owned" ? entry.linked ?? null : null;
  const metadata = [
    entry.team ? `${entry.team.shortName}· ${entry.team.name}` : null,
    entry.revision ? `r${entry.revision}` : null,
    entry.author,
    entry.publishedAt ? formatPublishedAt(entry.publishedAt) : null,
    linked
      ? linked.updateAvailable
        ? tf("team has r{revision}", { revision: String(linked.updateAvailable) })
        : linked.dirty
          ? t("edited since the last publish")
          : t("in sync with the team")
      : null,
    describeArrangement(entry.layout),
  ].filter(Boolean).join(" · ");

  return (
    <Box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0} data-gloom-role="layout-gallery-preview">
      <Box
        height={3}
        flexDirection="column"
        justifyContent="center"
        paddingX={1}
        flexShrink={0}
        style={{ borderBottom: `1px solid ${colors.border}` }}
      >
        <Box height={1} flexDirection="row" alignItems="center" gap={1} minWidth={0}>
          <Text
            fg={colors.textBright}
            attributes={TextAttributes.BOLD}
            style={{ ...ELLIPSIS, minWidth: 0, flexShrink: 1 }}
          >
            {entry.name}
          </Text>
          {entry.active && <Badge label={t("Active")} tone="accent" />}
        </Box>
        <Text fg={colors.textMuted} style={ELLIPSIS}>{metadata}</Text>
      </Box>

      <Box flexGrow={1} minWidth={0} minHeight={8} overflow="hidden" padding={1}>
        <MiniWorkspace
          layout={entry.layout}
          panes={controller.panes}
          width={PREVIEW.width}
          height={PREVIEW.height}
          detail
        />
      </Box>
    </Box>
  );
}

export function LayoutGalleryDesktop({
  controller,
  search,
  focused = true,
  width = 118,
  height = 34,
}: {
  controller: LayoutGalleryController;
  /** Search focus lives with the gallery, whose `/` key focuses it. */
  search?: GallerySearchState;
  focused?: boolean;
  width?: number;
  height?: number;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const sidebarWidth = getPaneSidebarWidth(width, !!nativePaneChrome);
  const selected = resolvePreviewEntry(controller);
  const inputRef = useRef<InputRenderable | null>(null);
  const [localSearchActive, setLocalSearchActive] = useState(false);
  const searchActive = search?.active ?? localSearchActive;
  const setSearchActive = search?.setActive ?? setLocalSearchActive;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSection = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // The rows the keyboard walks, in the order the sidebar shows them.
  const visibleEntries = useMemo(() => [
    ...(collapsed.has("owned") ? [] : controller.owned),
    ...controller.teamSections.flatMap(({ team, entries }) => (collapsed.has(`team:${team.id}`) ? [] : entries)),
    ...(collapsed.has("discover") ? [] : controller.community),
  ], [collapsed, controller.community, controller.owned, controller.teamSections]);

  useShortcut((event) => {
    if (event.targetEditable || searchActive) return;
    const delta = isPlainKey(event, "down", "j") ? 1 : isPlainKey(event, "up", "k") ? -1 : 0;
    if (!delta || visibleEntries.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const index = visibleEntries.findIndex((entry) => entry.id === selected?.id);
    const next = visibleEntries[Math.max(0, Math.min(visibleEntries.length - 1, index < 0 ? 0 : index + delta))];
    if (next) controller.select(next.id);
  }, { enabled: focused, phase: "before", scope: "layout-gallery" });

  const section = (id: string, title: string, count: number, listWidth: number) => (
    <SidebarSection
      title={title}
      count={count}
      expanded={!collapsed.has(id)}
      width={listWidth}
      onToggle={() => toggleSection(id)}
    />
  );

  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      overflow="hidden"
      data-gloom-role="layout-gallery"
    >
      <QueryBar
        width={width}
        search={{
          value: controller.query,
          onChange: controller.setQuery,
          placeholder: t("layouts and panes"),
          focused,
          active: searchActive,
          onActiveChange: setSearchActive,
          focusToken: search?.focusToken,
          inputRef,
          debounceMs: 80,
        }}
      />
      <Box flexDirection="row" flexGrow={1} flexBasis={0} minHeight={0} minWidth={0}>
        <PaneSidebar width={sidebarWidth} height={Math.max(1, height - 1)} focused={focused}>
          {({ listWidth }) => (
            <ScrollBox
              scrollY
              flexGrow={1}
              minHeight={0}
              focusable={false}
              data-gloom-role="layout-gallery-sidebar"
            >
              {section("owned", "Your layouts", controller.owned.length, listWidth)}
              {collapsed.has("owned") ? null : controller.owned.length === 0 ? (
                <SidebarNote>
                  {controller.query.trim()
                    ? t("No saved layouts match this search.")
                    : t("No saved layouts yet.")}
                </SidebarNote>
              ) : controller.owned.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  controller={controller}
                  selected={entry.id === selected?.id}
                />
              ))}

              {controller.teamSections.map(({ team, entries }) => (
                <Box key={team.id} flexDirection="column">
                  {section(`team:${team.id}`, `${team.shortName}· ${team.name}`, entries.length, listWidth)}
                  {collapsed.has(`team:${team.id}`) ? null : entries.length === 0 ? (
                    <TeamStatus controller={controller} />
                  ) : entries.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      controller={controller}
                      selected={entry.id === selected?.id}
                    />
                  ))}
                </Box>
              ))}

              {section("discover", "Discover", controller.community.length, listWidth)}
              {collapsed.has("discover") ? null : (
                <>
                  <DiscoverStatus controller={controller} />
                  {controller.community.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      controller={controller}
                      selected={entry.id === selected?.id}
                    />
                  ))}
                </>
              )}
            </ScrollBox>
          )}
        </PaneSidebar>

        <Box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
          {selected
            ? <PreviewPane controller={controller} entry={selected} />
            : <PreviewEmpty controller={controller} />}
        </Box>
      </Box>
    </Box>
  );
}
