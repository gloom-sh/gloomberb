import { useMemo, type ReactNode } from "react";
import { Box, ScrollBox, Text, TextAttributes } from "../ui";
import { Button } from "../components/ui/button";
import { TextField } from "../components/ui/fields";
import { Spinner } from "../components/ui/loading";
import { blendHex, hoverBg } from "../theme/colors";
import { useThemeColors } from "../theme/theme-context";
import { t, tf } from "../i18n";
import type { LayoutGalleryController } from "./gallery";
import { MiniWorkspace } from "./mini-workspace";
import {
  describeArrangement,
  formatPublishedAt,
  summarizeLayoutPanes,
  type GalleryEntry,
} from "./model";

const SIDEBAR_WIDTH = 316;
const PREVIEW = { width: 640, height: 320 };
const ELLIPSIS = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

function Chip({ children, color, background }: { children: ReactNode; color: string; background: string }) {
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      backgroundColor={background}
      style={{ borderRadius: 4, paddingInline: 5, flexShrink: 0 }}
    >
      <Text fg={color} style={{ fontSize: 10.5, lineHeight: "15px", fontWeight: 600 }}>{children}</Text>
    </Box>
  );
}

/**
 * One dense sidebar line. Pointer hover and keyboard focus both move the
 * selection, so the preview always describes whatever the user is pointing at.
 */
function Row({
  ariaLabel,
  selected = false,
  onHover,
  onPress,
  onEnter,
  children,
}: {
  ariaLabel: string;
  selected?: boolean;
  onHover?: () => void;
  onPress: () => void;
  onEnter?: () => void;
  children: ReactNode;
}) {
  const colors = useThemeColors();
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-current={selected ? "true" : undefined}
      data-gloom-role="layout-gallery-row"
      data-gloom-interactive="true"
      backgroundColor={selected ? colors.selected : "transparent"}
      hoverBackgroundColor={selected ? undefined : hoverBg(colors)}
      onMouseOver={onHover}
      onFocus={onHover}
      onMouseDown={onPress}
      onKeyDown={(event: { key?: string; preventDefault?: () => void; stopPropagation?: () => void }) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault?.();
        event.stopPropagation?.();
        (onEnter ?? onPress)();
      }}
      style={{
        gap: 6,
        paddingInline: 8,
        paddingBlock: 3,
        borderRadius: 5,
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {children}
    </Box>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  const colors = useThemeColors();
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      style={{ gap: 6, paddingInline: 8, paddingTop: 10, paddingBottom: 3, flexShrink: 0 }}
    >
      <Text
        fg={colors.textMuted}
        attributes={TextAttributes.BOLD}
        style={{ fontSize: 10.5, letterSpacing: 0.7, textTransform: "uppercase", fontWeight: 700 }}
      >
        {t(title)}
      </Text>
      <Text fg={colors.textDim} style={{ fontSize: 10.5 }}>{String(count)}</Text>
    </Box>
  );
}

function SidebarNote({ children }: { children: ReactNode }) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="row" alignItems="center" style={{ gap: 6, paddingInline: 8, paddingBlock: 4 }}>
      <Text fg={colors.textDim} wrapText style={{ fontSize: 12 }}>{children}</Text>
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

  return (
    <Row
      ariaLabel={tf("{name}, {panes} panes", { name: entry.name, panes: String(panes.length) })}
      selected={selected}
      onHover={() => controller.select(entry.id)}
      onPress={() => controller.select(entry.id)}
      onEnter={() => (entry.kind === "community" ? controller.install(entry) : controller.activate(entry))}
    >
      {entry.active && (
        <Box
          backgroundColor={colors.borderFocused}
          style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0 }}
        />
      )}
      <Text
        fg={selected ? colors.selectedText : colors.text}
        attributes={entry.active ? TextAttributes.BOLD : 0}
        style={{ ...ELLIPSIS, flexShrink: 1, minWidth: 0 }}
      >
        {entry.name}
      </Text>
      <Box flexGrow={1} style={{ minWidth: 0 }} />
      {entry.author && (
        <Text fg={selected ? colors.selectedText : colors.textMuted} style={{ ...ELLIPSIS, fontSize: 11.5, maxWidth: 96 }}>
          {entry.author}
        </Text>
      )}
      {missing > 0 && (
        <Text fg={colors.warning} style={{ fontSize: 11.5 }}>
          {tf("{count} missing", { count: String(missing) })}
        </Text>
      )}
    </Row>
  );
}

/** Account gate, load, error and empty states for the Discover section. */
function DiscoverStatus({ controller }: { controller: LayoutGalleryController }) {
  const colors = useThemeColors();
  const { discover } = controller;

  if (!controller.signedIn) {
    return (
      <>
        <SidebarNote>{t("A Gloom account is required to browse community layouts.")}</SidebarNote>
        <Row ariaLabel={t("Log in")} onPress={controller.requestSignIn}>
          <Text fg={colors.borderFocused} style={{ fontSize: 12, fontWeight: 600 }}>{t("Log in")}</Text>
        </Row>
      </>
    );
  }
  if (discover.state.status === "loading" || discover.state.status === "idle") {
    return (
      <Box flexDirection="row" alignItems="center" style={{ gap: 6, paddingInline: 8, paddingBlock: 4 }}>
        <Spinner />
        <Text fg={colors.textDim} style={{ fontSize: 12 }}>{t("Loading community layouts…")}</Text>
      </Box>
    );
  }
  if (discover.state.status === "error") {
    return (
      <>
        <SidebarNote>
          <Text fg={colors.negative} wrapText style={{ fontSize: 12 }}>{discover.state.error}</Text>
        </SidebarNote>
        <Row ariaLabel={t("Retry")} onPress={discover.refresh}>
          <Text fg={colors.borderFocused} style={{ fontSize: 12, fontWeight: 600 }}>{t("Retry")}</Text>
        </Row>
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
      style={{ gap: 6, padding: 24, minHeight: 0 }}
    >
      <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
        {searching ? t("No layouts match this search.") : t("No layout selected.")}
      </Text>
      <Text fg={colors.textDim} wrapText style={{ fontSize: 12, textAlign: "center" }}>
        {searching
          ? t("Clear the search to see your saved layouts.")
          : t("Pick a layout on the left to preview its panes.")}
      </Text>
    </Box>
  );
}

function PreviewPane({
  controller,
  entry,
}: {
  controller: LayoutGalleryController;
  entry: GalleryEntry;
}) {
  const colors = useThemeColors();
  const panes = useMemo(
    () => summarizeLayoutPanes(entry.layout, controller.panes),
    [controller.panes, entry.layout],
  );
  const missing = panes.filter((pane) => pane.missing);
  const dependencies = [...new Set(panes.filter((pane) => !pane.missing).map((pane) => pane.name))];
  const community = entry.kind === "community";

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      data-gloom-role="layout-gallery-preview"
      style={{ padding: 14, gap: 10, minHeight: 0, minWidth: 0 }}
    >
      <Box flexDirection="row" alignItems="center" style={{ gap: 8, flexShrink: 0 }}>
        <Text
          fg={colors.textBright}
          attributes={TextAttributes.BOLD}
          style={{ ...ELLIPSIS, fontSize: 15, minWidth: 0, flexShrink: 1 }}
        >
          {entry.name}
        </Text>
        {entry.active && (
          <Chip color={colors.bg} background={colors.borderFocused}>{t("Active")}</Chip>
        )}
        <Box flexGrow={1} style={{ minWidth: 0 }} />
        <Text fg={colors.textMuted} style={{ ...ELLIPSIS, fontSize: 12 }}>
          {[
            entry.author,
            entry.publishedAt ? formatPublishedAt(entry.publishedAt) : null,
            describeArrangement(entry.layout),
          ].filter(Boolean).join(" · ")}
        </Text>
      </Box>

      <Box
        flexGrow={2}
        backgroundColor={blendHex(colors.panel, colors.bg, 0.4)}
        style={{
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
          padding: 8,
          minWidth: 0,
          minHeight: 150,
          maxHeight: 420,
          overflow: "hidden",
        }}
      >
        {/* The preview scales to the box it gets: a grid row is definite, so the
            SVG resolves its 100% height instead of falling back to its viewBox. */}
        <Box
          flexGrow={1}
          style={{ display: "grid", gridTemplateRows: "1fr", width: "100%", minWidth: 0, minHeight: 0 }}
        >
          <MiniWorkspace
            layout={entry.layout}
            panes={controller.panes}
            width={PREVIEW.width}
            height={PREVIEW.height}
            detail
          />
        </Box>
      </Box>

      <Box flexDirection="row" alignItems="center" style={{ gap: 6, flexShrink: 0 }}>
        <Button
          label={community ? "Add Layout" : "Use Layout"}
          variant="primary"
          onPress={() => (community ? controller.install(entry) : controller.activate(entry))}
        />
        {entry.kind === "owned" && (
          <>
            <Button label="Rename" variant="secondary" onPress={() => controller.renameLayout(entry)} />
            <Button label="Duplicate" variant="secondary" onPress={() => controller.duplicateLayout(entry)} />
            <Button
              label="Delete"
              variant="secondary"
              disabled={!controller.canDelete}
              onPress={() => controller.deleteLayout(entry)}
            />
          </>
        )}
        <Box flexGrow={1} style={{ minWidth: 0 }} />
        {community && (
          <Text fg={colors.textMuted} style={{ ...ELLIPSIS, fontSize: 11.5 }}>
            {t("Installs as an independent copy you can edit.")}
          </Text>
        )}
      </Box>

      <ScrollBox scrollY flexGrow={1} style={{ minHeight: 0, minWidth: 0 }}>
        <Box flexDirection="column" style={{ gap: 1, width: "100%" }}>
          {panes.map((pane) => (
            <Box
              key={pane.instanceId}
              flexDirection="row"
              alignItems="center"
              style={{ gap: 8, paddingBlock: 1 }}
            >
              <Text fg={colors.textMuted} style={{ fontSize: 10.5, width: 20, flexShrink: 0 }}>
                {pane.icon}
              </Text>
              <Text
                fg={pane.missing ? colors.textMuted : colors.text}
                style={{ ...ELLIPSIS, fontSize: 12.5, minWidth: 0, flexShrink: 1 }}
              >
                {pane.symbol ? `${pane.name} · ${pane.symbol}` : pane.name}
              </Text>
              <Box flexGrow={1} style={{ minWidth: 0 }} />
              <Text
                fg={pane.missing ? colors.warning : colors.textMuted}
                style={{ fontSize: 11.5 }}
              >
                {pane.missing ? t("unavailable") : pane.placement}
              </Text>
            </Box>
          ))}
          {missing.length > 0 && (
            <Text fg={colors.warning} wrapText style={{ fontSize: 11.5, marginTop: 6 }}>
              {missing.length === 1
                ? t("1 pane type is not installed here and stays hidden.")
                : tf("{count} pane types are not installed here and stay hidden.", {
                  count: String(missing.length),
                })}
            </Text>
          )}
          <Text fg={colors.textMuted} wrapText style={{ fontSize: 11.5, marginTop: 6 }}>
            {tf("Requires: {panes}", { panes: dependencies.join(", ") || "-" })}
          </Text>
        </Box>
      </ScrollBox>
    </Box>
  );
}

export function LayoutGalleryDesktop({ controller }: { controller: LayoutGalleryController }) {
  const colors = useThemeColors();
  // The preview never goes blank while layouts exist: selection, then the layout
  // in use, then the first row.
  const selected = controller.entries.find((entry) => entry.id === controller.selectedId)
    ?? controller.owned.find((entry) => entry.active)
    ?? controller.entries[0]
    ?? null;

  return (
    <Box
      flexGrow={1}
      flexDirection="column"
      backgroundColor={colors.bg}
      data-gloom-role="layout-gallery"
      style={{ minHeight: 0, overflow: "hidden" }}
    >
      <Box
        flexDirection="row"
        alignItems="center"
        style={{
          gap: 8,
          paddingInline: 12,
          paddingBlock: 8,
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}
      >
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD} style={{ fontSize: 13 }}>
          {t("Layouts")}
        </Text>
        <Box
          backgroundColor={blendHex(colors.panel, colors.bg, 0.3)}
          style={{
            width: 240,
            border: `1px solid ${colors.border}`,
            borderRadius: 5,
            paddingInline: 8,
            flexShrink: 0,
          }}
        >
          <TextField
            value={controller.query}
            placeholder={t("Search layouts and panes")}
            onChange={controller.setQuery}
            variant="plain"
          />
        </Box>
        <Box flexGrow={1} style={{ minWidth: 0 }} />
        <Button label="New Layout" variant="secondary" onPress={controller.newLayout} />
        <Button
          label={controller.publishing ? "Publishing…" : "Publish Current"}
          variant="secondary"
          disabled={controller.publishing}
          onPress={controller.publishCurrent}
        />
        <Button label="Close" variant="ghost" onPress={controller.close} />
      </Box>

      <Box flexDirection="row" flexGrow={1} style={{ minHeight: 0 }}>
        <ScrollBox
          scrollY
          data-gloom-role="layout-gallery-sidebar"
          style={{
            width: SIDEBAR_WIDTH,
            minWidth: SIDEBAR_WIDTH,
            flexShrink: 0,
            minHeight: 0,
            gap: 2,
            paddingInline: 6,
            paddingBottom: 8,
            borderRight: `1px solid ${colors.border}`,
          }}
        >
          <SectionHeader title="Your Layouts" count={controller.owned.length} />
          {controller.owned.length === 0 ? (
            <SidebarNote>
              {controller.query.trim()
                ? t("No saved layouts match this search.")
                : t("No saved layouts yet.")}
            </SidebarNote>
          ) : (
            controller.owned.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                controller={controller}
                selected={entry.id === selected?.id}
              />
            ))
          )}

          <SectionHeader title="Discover" count={controller.community.length} />
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

        <Box flexDirection="column" flexGrow={1} style={{ minWidth: 0, minHeight: 0 }}>
          {selected
            ? <PreviewPane controller={controller} entry={selected} />
            : <PreviewEmpty controller={controller} />}
        </Box>
      </Box>
    </Box>
  );
}
