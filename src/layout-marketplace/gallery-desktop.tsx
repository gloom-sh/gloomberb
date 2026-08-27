import { useMemo, type ReactNode } from "react";
import {
  getPaneSidebarWidth,
  PaneSidebar,
  PaneSidebarRow,
} from "../components/layout/pane/sidebar";
import { Button } from "../components/ui/button";
import { TextField } from "../components/ui/fields";
import { Spinner } from "../components/ui/loading";
import { t, tf } from "../i18n";
import { useThemeColors } from "../theme/theme-context";
import { Box, ScrollBox, Text, TextAttributes, useUiCapabilities } from "../ui";
import type { LayoutGalleryController } from "./gallery";
import { MiniWorkspace } from "./mini-workspace";
import {
  describeArrangement,
  formatPublishedAt,
  summarizeLayoutPanes,
  type GalleryEntry,
} from "./model";

const PREVIEW = { width: 640, height: 320 };
const ELLIPSIS = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

function SidebarSection({ title, count }: { title: string; count: number }) {
  const colors = useThemeColors();
  return (
    <Box height={1} flexDirection="row" alignItems="center" paddingX={1} flexShrink={0}>
      <Text fg={colors.textMuted} attributes={TextAttributes.BOLD}>
        {`${t(title).toUpperCase()} ${count}`}
      </Text>
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

function SidebarActionRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <PaneSidebarRow active={false} ariaLabel={label} onSelect={onPress}>
      {({ foregroundColor, listWidth, onMouseDown }) => (
        <Box
          width={listWidth}
          height={1}
          flexDirection="row"
          role="button"
          tabIndex={0}
          aria-label={label}
          data-gloom-role="layout-gallery-row"
          data-gloom-interactive="true"
          onMouseDown={onMouseDown}
          onKeyDown={(event: { key?: string; preventDefault?: () => void; stopPropagation?: () => void }) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault?.();
            event.stopPropagation?.();
            onPress();
          }}
          style={{ cursor: "pointer" }}
        >
          <Text fg={foregroundColor}>{`  ${label}`}</Text>
        </Box>
      )}
    </PaneSidebarRow>
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
  const activate = () => (entry.kind === "community" ? controller.install(entry) : controller.activate(entry));

  return (
    <PaneSidebarRow
      active={selected}
      ariaLabel={tf("{name}, {panes} panes", { name: entry.name, panes: String(panes.length) })}
      onSelect={select}
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
      <>
        <SidebarNote>{t("A Gloom account is required to browse community layouts.")}</SidebarNote>
        <SidebarActionRow label={t("Log in")} onPress={controller.requestSignIn} />
      </>
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
      <>
        <SidebarNote><Text fg={colors.negative} wrapText>{discover.state.error}</Text></SidebarNote>
        <SidebarActionRow label={t("Retry")} onPress={discover.refresh} />
      </>
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

function PreviewPane({ controller, entry }: { controller: LayoutGalleryController; entry: GalleryEntry }) {
  const colors = useThemeColors();
  const panes = useMemo(
    () => summarizeLayoutPanes(entry.layout, controller.panes),
    [controller.panes, entry.layout],
  );
  const community = entry.kind === "community";
  const metadata = [
    entry.author,
    entry.publishedAt ? formatPublishedAt(entry.publishedAt) : null,
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
        <Box height={1} flexDirection="row" alignItems="center" minWidth={0}>
          <Text
            fg={colors.textBright}
            attributes={TextAttributes.BOLD}
            style={{ ...ELLIPSIS, minWidth: 0, flexShrink: 1 }}
          >
            {entry.name}
          </Text>
          {entry.active && <Text fg={colors.borderFocused}>{`  ${t("ACTIVE")}`}</Text>}
          <Box flexGrow={1} minWidth={0} />
          <Button label="New Layout" variant="secondary" onPress={controller.newLayout} />
          <Box width={1} />
          <Button
            label={controller.publishing ? "Publishing…" : "Publish Current"}
            variant="secondary"
            disabled={controller.publishing}
            onPress={controller.publishCurrent}
          />
        </Box>
        <Text fg={colors.textMuted} style={ELLIPSIS}>{metadata}</Text>
      </Box>

      <Box flexGrow={2} minWidth={0} minHeight={8} overflow="hidden" padding={1}>
        <MiniWorkspace
          layout={entry.layout}
          panes={controller.panes}
          width={PREVIEW.width}
          height={PREVIEW.height}
          detail
        />
      </Box>

      <Box
        height={2}
        flexDirection="row"
        alignItems="center"
        paddingX={1}
        flexShrink={0}
        style={{ borderTop: `1px solid ${colors.border}` }}
      >
        <Button
          label={community ? "Add Layout" : "Use Layout"}
          variant="primary"
          onPress={() => (community ? controller.install(entry) : controller.activate(entry))}
        />
        {entry.kind === "owned" && (
          <>
            <Box width={1} />
            <Button label="Rename" variant="secondary" onPress={() => controller.renameLayout(entry)} />
            <Box width={1} />
            <Button label="Duplicate" variant="secondary" onPress={() => controller.duplicateLayout(entry)} />
            <Box width={1} />
            <Button
              label="Delete"
              variant="secondary"
              disabled={!controller.canDelete}
              onPress={() => controller.deleteLayout(entry)}
            />
          </>
        )}
        <Box flexGrow={1} minWidth={0} />
        {community && (
          <Text fg={colors.textMuted} style={{ ...ELLIPSIS, minWidth: 0 }}>
            {t("Adds an editable copy")}
          </Text>
        )}
      </Box>

      <Box flexGrow={1} minHeight={6} flexDirection="column" style={{ borderTop: `1px solid ${colors.border}` }}>
        <Box height={1} flexDirection="row" paddingX={1} backgroundColor={colors.panel} flexShrink={0}>
          <Text fg={colors.textMuted} attributes={TextAttributes.BOLD}>{t("PANE")}</Text>
          <Box flexGrow={1} />
          <Text fg={colors.textMuted} attributes={TextAttributes.BOLD}>{t("PLACEMENT")}</Text>
        </Box>
        <ScrollBox scrollY flexGrow={1} minHeight={0} focusable={false}>
          {panes.map((pane) => (
            <Box key={pane.instanceId} height={1} flexDirection="row" paddingX={1} minWidth={0}>
              <Text fg={colors.textMuted}>{`${pane.icon} `}</Text>
              <Text
                fg={pane.missing ? colors.textMuted : colors.text}
                style={{ ...ELLIPSIS, minWidth: 0, flexShrink: 1 }}
              >
                {pane.symbol ? `${pane.name} · ${pane.symbol}` : pane.name}
              </Text>
              <Box flexGrow={1} minWidth={0} />
              <Text fg={pane.missing ? colors.warning : colors.textMuted}>
                {pane.missing ? t("unavailable") : pane.placement}
              </Text>
            </Box>
          ))}
        </ScrollBox>
      </Box>
    </Box>
  );
}

export function LayoutGalleryDesktop({
  controller,
  focused = true,
  width = 118,
  height = 34,
}: {
  controller: LayoutGalleryController;
  focused?: boolean;
  width?: number;
  height?: number;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const sidebarWidth = getPaneSidebarWidth(width, !!nativePaneChrome);
  const selected = controller.entries.find((entry) => entry.id === controller.selectedId)
    ?? controller.owned.find((entry) => entry.active)
    ?? controller.entries[0]
    ?? null;

  return (
    <Box
      width={width}
      height={height}
      flexDirection="row"
      overflow="hidden"
      data-gloom-role="layout-gallery"
    >
      <PaneSidebar width={sidebarWidth} height={height} focused={focused}>
        {({ listWidth }) => (
          <>
            <Box height={2} paddingX={1} justifyContent="center" flexShrink={0}>
              <TextField
                value={controller.query}
                placeholder={t("Search layouts")}
                onChange={controller.setQuery}
                width={Math.max(1, listWidth - 2)}
              />
            </Box>
            <ScrollBox
              scrollY
              flexGrow={1}
              minHeight={0}
              focusable={false}
              data-gloom-role="layout-gallery-sidebar"
            >
              <SidebarSection title="Your Layouts" count={controller.owned.length} />
              {controller.owned.length === 0 ? (
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

              <SidebarSection title="Discover" count={controller.community.length} />
              <DiscoverStatus controller={controller} />
              {controller.community.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  controller={controller}
                  selected={entry.id === selected?.id}
                />
              ))}
            </ScrollBox>
          </>
        )}
      </PaneSidebar>

      <Box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
        {selected
          ? <PreviewPane controller={controller} entry={selected} />
          : <PreviewEmpty controller={controller} />}
      </Box>
    </Box>
  );
}
