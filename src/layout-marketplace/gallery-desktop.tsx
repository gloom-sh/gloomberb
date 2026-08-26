import { type ReactNode } from "react";
import { Box, ScrollBox, Text, TextAttributes } from "../ui";
import { Button } from "../components/ui/button";
import { TextField } from "../components/ui/fields";
import { Spinner } from "../components/ui/loading";
import { blendHex } from "../theme/colors";
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

const CARD_PREVIEW = { width: 320, height: 148 };

function Chip({
  children,
  color,
  background,
  border,
}: {
  children: ReactNode;
  color: string;
  background: string;
  border: string;
}) {
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      backgroundColor={background}
      style={{
        border: `1px solid ${border}`,
        borderRadius: 999,
        paddingInline: 7,
        paddingBlock: 1,
      }}
    >
      <Text fg={color} style={{ fontSize: 11 }}>{children}</Text>
    </Box>
  );
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="row" alignItems="baseline" gap={1} style={{ marginBottom: 8 }}>
      <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{t(title)}</Text>
      {hint && <Text fg={colors.textMuted} style={{ fontSize: 12 }}>{hint}</Text>}
    </Box>
  );
}

function LayoutCard({
  entry,
  controller,
  onOpen,
}: {
  entry: GalleryEntry;
  controller: LayoutGalleryController;
  onOpen: () => void;
}) {
  const colors = useThemeColors();
  const selected = controller.selectedId === entry.id;
  const missing = controller.missingPaneIds(entry.layout);
  const paneCount = summarizeLayoutPanes(entry.layout, controller.panes).length;
  const surface = blendHex(colors.panel, colors.bg, 0.35);

  return (
    <Box
      flexDirection="column"
      backgroundColor={surface}
      hoverBackgroundColor={blendHex(surface, colors.textBright, 0.06)}
      role="group"
      aria-label={tf("{name}, {panes} panes", { name: entry.name, panes: String(paneCount) })}
      data-gloom-role="layout-gallery-card"
      onMouseOver={() => controller.select(entry.id)}
      style={{
        border: `1px solid ${selected ? colors.borderFocused : colors.border}`,
        borderRadius: 8,
        padding: 10,
        gap: 8,
        cursor: "pointer",
        outline: "none",
      }}
    >
      <Box
        flexDirection="column"
        gap={1}
        role="button"
        tabIndex={0}
        aria-label={entry.kind === "community" ? tf("Preview {name}", { name: entry.name }) : tf("Open {name}", { name: entry.name })}
        data-gloom-interactive="true"
        data-gloom-role="layout-gallery-card-open"
        onMouseDown={onOpen}
        onKeyDown={(event: { key?: string; preventDefault?: () => void }) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault?.();
            onOpen();
          }
        }}
        style={{ cursor: "pointer", outline: "none" }}
      >
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
          <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{entry.name}</Text>
          {entry.active && (
            <Chip
              color={colors.bg}
              background={colors.borderFocused}
              border={colors.borderFocused}
            >
              {t("Active")}
            </Chip>
          )}
          {entry.author && (
            <Text fg={colors.textMuted} style={{ fontSize: 12 }}>{entry.author}</Text>
          )}
        </Box>

        <Box style={{ height: 148, borderRadius: 6, overflow: "hidden" }}>
          <MiniWorkspace
            layout={entry.layout}
            panes={controller.panes}
            width={CARD_PREVIEW.width}
            height={CARD_PREVIEW.height}
          />
        </Box>

        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
          <Text fg={colors.textMuted} style={{ fontSize: 12 }}>
            {describeArrangement(entry.layout)}
          </Text>
          {missing.length > 0 && (
            <Chip
              color={colors.warning}
              background={blendHex(colors.panel, colors.warning, 0.12)}
              border={blendHex(colors.border, colors.warning, 0.4)}
            >
              {tf("{count} unavailable", { count: String(missing.length) })}
            </Chip>
          )}
        </Box>
      </Box>

      {entry.kind === "owned" && (
        <Box flexDirection="row" gap={1}>
          <Button
            label="Rename"
            variant="ghost"
            onPress={() => controller.renameLayout(entry)}
          />
          <Button
            label="Duplicate"
            variant="ghost"
            onPress={() => controller.duplicateLayout(entry)}
          />
          <Button
            label="Delete"
            variant="ghost"
            disabled={!controller.canDelete}
            onPress={() => controller.deleteLayout(entry)}
          />
        </Box>
      )}
    </Box>
  );
}

function CardGrid({ children }: { children: ReactNode }) {
  return (
    <Box
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 340px))",
        gap: 14,
        alignItems: "stretch",
        justifyContent: "start",
        width: "100%",
      }}
    >
      {children}
    </Box>
  );
}

function DiscoverStatus({ controller }: { controller: LayoutGalleryController }) {
  const colors = useThemeColors();
  const { discover } = controller;

  if (!controller.signedIn) {
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text fg={colors.textDim}>{t("A Gloom account is required to browse community layouts.")}</Text>
        <Button label="Log in" variant="primary" onPress={controller.requestSignIn} />
      </Box>
    );
  }
  if (discover.state.status === "loading" || discover.state.status === "idle") {
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Spinner />
        <Text fg={colors.textDim}>{t("Loading community layouts…")}</Text>
      </Box>
    );
  }
  if (discover.state.status === "error") {
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text fg={colors.negative}>{discover.state.error}</Text>
        <Button label="Retry" variant="secondary" onPress={discover.refresh} />
      </Box>
    );
  }
  if (controller.community.length === 0) {
    return (
      <Text fg={colors.textDim}>
        {controller.query.trim()
          ? t("No community layouts match this search.")
          : t("No community layouts published yet.")}
      </Text>
    );
  }
  return null;
}

function DetailView({ controller }: { controller: LayoutGalleryController }) {
  const colors = useThemeColors();
  const entry = controller.detail!;
  const panes = summarizeLayoutPanes(entry.layout, controller.panes);
  const missing = panes.filter((pane) => pane.missing);
  const dependencies = [...new Set(panes.filter((pane) => !pane.missing).map((pane) => pane.name))];

  return (
    <Box flexDirection="column" flexGrow={1} style={{ padding: 16, gap: 12, minHeight: 0 }}>
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Button label="Back" variant="ghost" onPress={controller.closeDetail} />
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{entry.name}</Text>
        {entry.author && <Text fg={colors.textMuted}>{entry.author}</Text>}
        {entry.publishedAt && (
          <Text fg={colors.textMuted} style={{ fontSize: 12 }}>
            {formatPublishedAt(entry.publishedAt)}
          </Text>
        )}
      </Box>

      <Box flexDirection="row" gap={2} flexGrow={1} style={{ minHeight: 0 }}>
        <Box
          flexDirection="column"
          flexGrow={1}
          style={{ minWidth: 0, maxWidth: 800, alignSelf: "flex-start", gap: 12 }}
        >
          <Box
            alignItems="center"
            backgroundColor={blendHex(colors.panel, colors.bg, 0.35)}
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              padding: 12,
              minWidth: 0,
            }}
          >
            <Box style={{ width: "100%", maxWidth: 760, maxHeight: 400, aspectRatio: "2 / 1" }}>
              <MiniWorkspace
                layout={entry.layout}
                panes={controller.panes}
                width={640}
                height={320}
                detail
              />
            </Box>
          </Box>

          <Box flexDirection="row" gap={1} alignItems="center">
            <Button
              label={entry.kind === "community" ? "Add Layout" : "Open Layout"}
              variant="primary"
              onPress={() => (entry.kind === "community"
                ? controller.install(entry)
                : controller.activate(entry))}
            />
            <Text fg={colors.textMuted} style={{ fontSize: 12 }}>
              {t("Installs as an independent copy you can edit.")}
            </Text>
          </Box>
        </Box>

        <ScrollBox scrollY style={{ width: 300, minWidth: 300, minHeight: 0 }}>
          <Box flexDirection="column" gap={1} style={{ width: "100%" }}>
            <Text fg={colors.textMuted} style={{ fontSize: 12 }}>
              {describeArrangement(entry.layout)}
            </Text>
            <SectionHeading title="Panes" />
            {panes.map((pane) => (
              <Box key={pane.instanceId} flexDirection="row" justifyContent="space-between" gap={1}>
                <Text fg={pane.missing ? colors.textMuted : colors.text}>
                  {pane.symbol ? `${pane.name} · ${pane.symbol}` : pane.name}
                </Text>
                <Text fg={colors.textMuted} style={{ fontSize: 12 }}>
                  {pane.missing ? t("unavailable") : pane.placement}
                </Text>
              </Box>
            ))}
            {missing.length > 0 && (
              <Text fg={colors.warning} wrapText style={{ fontSize: 12 }}>
                {missing.length === 1
                  ? t("1 pane type is not installed here and stays hidden.")
                  : tf("{count} pane types are not installed here and stay hidden.", {
                    count: String(missing.length),
                  })}
              </Text>
            )}
            <Text fg={colors.textMuted} wrapText style={{ fontSize: 12 }}>
              {tf("Requires: {panes}", { panes: dependencies.join(", ") || "-" })}
            </Text>
          </Box>
        </ScrollBox>
      </Box>
    </Box>
  );
}

export function LayoutGalleryDesktop({ controller }: { controller: LayoutGalleryController }) {
  const colors = useThemeColors();

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
        gap={1}
        style={{
          padding: 12,
          gap: 10,
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{t("Layouts")}</Text>
        <Box
          flexGrow={1}
          backgroundColor={blendHex(colors.panel, colors.bg, 0.3)}
          style={{
            maxWidth: 320,
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            paddingInline: 8,
          }}
        >
          <TextField
            value={controller.query}
            placeholder={t("Search layouts and panes")}
            onChange={controller.setQuery}
            variant="plain"
          />
        </Box>
        <Box flexGrow={1} />
        <Button label="New Layout" variant="secondary" onPress={controller.newLayout} />
        <Button
          label={controller.publishing ? "Publishing…" : "Publish Current"}
          variant="secondary"
          disabled={controller.publishing}
          onPress={controller.publishCurrent}
        />
        <Button label="Close" variant="ghost" onPress={controller.close} />
      </Box>

      {controller.detail ? (
        <DetailView controller={controller} />
      ) : (
        <ScrollBox scrollY flexGrow={1} style={{ minHeight: 0, width: "100%" }}>
          <Box flexDirection="column" style={{ padding: 16, gap: 20, width: "100%" }}>
            <Box flexDirection="column" style={{ width: "100%" }}>
              <SectionHeading
                title="Your Layouts"
                hint={t("Saved on this machine, available offline")}
              />
              {controller.owned.length === 0 ? (
                <Text fg={colors.textDim}>{t("No saved layouts match this search.")}</Text>
              ) : (
                <CardGrid>
                  {controller.owned.map((entry) => (
                    <LayoutCard
                      key={entry.id}
                      entry={entry}
                      controller={controller}
                      onOpen={() => controller.activate(entry)}
                    />
                  ))}
                </CardGrid>
              )}
            </Box>

            <Box flexDirection="column" style={{ width: "100%" }}>
              <SectionHeading title="Discover" hint={t("Published by the community")} />
              <DiscoverStatus controller={controller} />
              {controller.community.length > 0 && (
                <CardGrid>
                  {controller.community.map((entry) => (
                    <LayoutCard
                      key={entry.id}
                      entry={entry}
                      controller={controller}
                      onOpen={() => controller.openDetail(entry)}
                    />
                  ))}
                </CardGrid>
              )}
            </Box>
          </Box>
        </ScrollBox>
      )}
    </Box>
  );
}
