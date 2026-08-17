import type { ReactNode } from "react";
import { Box, Text, TextAttributes, useUiHost } from "../../ui";
import { useViewport } from "../../react/input";
import { blendHex } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { t } from "../../i18n";
import { Button, ListView, type ListViewItem } from "../ui";
import type { ButtonProps } from "../ui/button";
import { Tabs } from "../ui/tabs";
import { TITLEBAR_OVERLAY_HEIGHT_PX } from "../layout/titlebar-overlay";

function desktopSurfaceStyle(
  borderColor: string,
  backgroundColor: string,
  shadowColor: string,
  highlightColor: string,
) {
  return {
    width: "min(540px, 100%)",
    height: "auto",
    maxHeight: "calc(100vh - 88px)",
    padding: 14,
    backgroundColor,
    border: `1px solid ${borderColor}`,
    borderRadius: 6,
    boxShadow: `0 18px 48px color-mix(in srgb, ${shadowColor} 46%, transparent), inset 0 1px 0 color-mix(in srgb, ${highlightColor} 5%, transparent)`,
    boxSizing: "border-box" as const,
    overflowY: "auto" as const,
  };
}

export function OnboardingModal({
  children,
  width = 66,
  height = 18,
}: {
  children: ReactNode;
  width?: number;
  height?: number;
}) {
  const colors = useThemeColors();
  const desktop = useUiHost().kind === "desktop-web";
  const viewport = useViewport();

  if (desktop) {
    return (
      <Box
        position="absolute"
        left={0}
        zIndex={9_998}
        alignItems="center"
        justifyContent="center"
        style={{
          top: TITLEBAR_OVERLAY_HEIGHT_PX,
          width: "100%",
          height: `calc(100% - ${TITLEBAR_OVERLAY_HEIGHT_PX}px)`,
          padding: 24,
          backgroundColor: `color-mix(in srgb, ${colors.bg} 64%, transparent)`,
          boxSizing: "border-box",
        }}
      >
        <Box
          flexDirection="column"
          style={desktopSurfaceStyle(
            blendHex(colors.border, colors.borderFocused, 0.18),
            blendHex(colors.panel, colors.bg, 0.12),
            colors.bg,
            colors.textBright,
          )}
          data-gloom-role="onboarding-modal"
        >
          {children}
        </Box>
      </Box>
    );
  }

  const overlayHeight = Math.max(1, viewport.height - 1);
  const availableWidth = Math.max(1, viewport.width - 4);
  const availableHeight = Math.max(1, overlayHeight - 1);
  const cardWidth = Math.min(Math.max(42, Math.min(width, availableWidth)), availableWidth);
  const cardHeight = Math.min(Math.max(10, Math.min(height, availableHeight)), availableHeight);
  const top = Math.max(0, Math.floor((overlayHeight - cardHeight) / 2));
  const left = Math.max(0, Math.floor((viewport.width - cardWidth) / 2));

  return (
    <Box
      position="absolute"
      top={1}
      left={0}
      width={viewport.width}
      height={overlayHeight}
      zIndex={9_998}
      backgroundColor={colors.bg}
    >
      <Box
        position="absolute"
        top={top}
        left={left}
        width={cardWidth}
        height={cardHeight}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
        backgroundColor={colors.panel}
        borderStyle="single"
        borderColor={colors.borderFocused}
        data-gloom-role="onboarding-modal"
      >
        {children}
      </Box>
    </Box>
  );
}

export function OnboardingCoach({
  step,
  title,
  children,
  actions,
}: {
  step: string;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  const colors = useThemeColors();
  const desktop = useUiHost().kind === "desktop-web";
  const viewport = useViewport();

  if (desktop) {
    return (
      <Box
        position="absolute"
        top={2}
        right={2}
        zIndex={90}
        width="min(392px, calc(100vw - 32px))"
        flexDirection="column"
        backgroundColor={blendHex(colors.panel, colors.bg, 0.12)}
        style={{
          height: "auto",
          padding: 14,
          border: `1px solid ${blendHex(colors.border, colors.borderFocused, 0.28)}`,
          borderRadius: 6,
          boxShadow: `0 14px 34px color-mix(in srgb, ${colors.bg} 42%, transparent), inset 0 1px 0 color-mix(in srgb, ${colors.textBright} 5%, transparent)`,
          boxSizing: "border-box",
        }}
        data-gloom-role="onboarding-coach"
      >
        <Text
          fg={colors.borderFocused}
          attributes={TextAttributes.BOLD}
        >
          {step}
        </Text>
        <Text
          fg={colors.textBright}
          attributes={TextAttributes.BOLD}
          style={{ marginTop: 4 }}
        >
          {title}
        </Text>
        <Box style={{ marginTop: 6 }}>{children}</Box>
        <Box flexDirection="row" justifyContent="flex-end" gap={1} style={{ marginTop: 12 }}>
          {actions}
        </Box>
      </Box>
    );
  }

  const availableWidth = Math.max(1, viewport.width - 4);
  const cardWidth = Math.min(Math.max(40, Math.min(54, availableWidth)), availableWidth);
  const cardHeight = Math.min(12, Math.max(1, viewport.height - 3));
  const right = viewport.width - cardWidth >= 2 ? 2 : 0;

  return (
    <Box
      position="absolute"
      top={2}
      right={right}
      width={cardWidth}
      height={cardHeight}
      zIndex={90}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      backgroundColor={colors.panel}
      borderStyle="single"
      borderColor={colors.borderFocused}
      data-gloom-role="onboarding-coach"
    >
      <Box height={1} flexDirection="row">
        <Text fg={colors.borderFocused} attributes={TextAttributes.BOLD}>{step}</Text>
      </Box>
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{title}</Text>
      </Box>
      <Box height={1} />
      <Box flexGrow={1} minHeight={0}>{children}</Box>
      <Box height={1} flexDirection="row" gap={1}>{actions}</Box>
    </Box>
  );
}

export function OnboardingTitle({
  step,
  title,
  titlePrefix,
  description,
}: {
  step?: string;
  title: string;
  titlePrefix?: ReactNode;
  description?: string;
}) {
  const colors = useThemeColors();
  const desktop = useUiHost().kind === "desktop-web";

  if (desktop) {
    return (
      <Box flexDirection="column" style={{ marginTop: 14 }}>
        {step ? (
          <Text
            fg={colors.borderFocused}
            attributes={TextAttributes.BOLD}
          >
            {step}
          </Text>
        ) : null}
        <Box
          flexDirection="row"
          alignItems="baseline"
          gap={titlePrefix ? 1 : 0}
          minWidth={0}
          style={{ marginTop: step ? 4 : 0 }}
        >
          {titlePrefix}
          <Text
            fg={colors.textBright}
            attributes={TextAttributes.BOLD}
            wrapText
          >
            {title}
          </Text>
        </Box>
        {description ? (
          <Text
            fg={colors.textDim}
            wrapText
            style={{ marginTop: 6 }}
          >
            {description}
          </Text>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {step ? (
        <Box height={1}>
          <Text fg={colors.borderFocused} attributes={TextAttributes.BOLD}>{step}</Text>
        </Box>
      ) : null}
      <Box height={1} flexDirection="row" gap={titlePrefix ? 1 : 0}>
        {titlePrefix}
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{title}</Text>
      </Box>
      {description ? (
        <>
          <Box height={1} />
          <Box minHeight={2}>
            <Text fg={colors.textDim} wrapText>{description}</Text>
          </Box>
        </>
      ) : null}
    </Box>
  );
}

export type OnboardingSectionId = "portfolio" | "cloud" | "pro";

export function OnboardingHeader({
  active,
  available,
  onNavigate,
  onDismiss,
  dismissing = false,
  dismissDisabled = false,
  showDismiss = true,
}: {
  active?: OnboardingSectionId;
  available?: Partial<Record<OnboardingSectionId, boolean>>;
  onNavigate?: (section: OnboardingSectionId) => void;
  onDismiss: () => void;
  dismissing?: boolean;
  dismissDisabled?: boolean;
  showDismiss?: boolean;
}) {
  const colors = useThemeColors();
  const desktop = useUiHost().kind === "desktop-web";
  const sections: Array<{ id: OnboardingSectionId; label: string }> = [
    { id: "portfolio", label: t("Portfolio") },
    { id: "cloud", label: t("Gloom Cloud") },
    { id: "pro", label: t("Pro") },
  ];

  if (!desktop) {
    return (
      <Box height={1} flexDirection="row" justifyContent="space-between">
        <Text fg={colors.textMuted}>{t("GLOOMBERB SETUP")}</Text>
        {showDismiss ? (
          <Button
            label={dismissing ? "Closing..." : "Skip setup"}
            variant="ghost"
            disabled={dismissing || dismissDisabled}
            shortcut="F10"
            onPress={onDismiss}
          />
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="row" alignItems="center" justifyContent="space-between" minWidth={0}>
      <Box flexDirection="row" alignItems="center" flexGrow={1} minWidth={0}>
        {active ? (
          <Tabs
            tabs={sections.map((section) => ({
              label: section.label,
              value: section.id,
              disabled: available?.[section.id] === false,
            }))}
            activeValue={active}
            onSelect={(value) => onNavigate?.(value as OnboardingSectionId)}
            dense
            variant="underline"
            keyboardNavigation={false}
            scrollable={false}
          />
        ) : (
          <Text fg={colors.textMuted} attributes={TextAttributes.BOLD}>
            {t("GLOOMBERB SETUP")}
          </Text>
        )}
      </Box>
      {showDismiss ? (
        <Box flexDirection="row" style={{ marginLeft: 12, flexShrink: 0 }}>
          <Button
            label={dismissing ? "Closing..." : "Skip setup"}
            variant="ghost"
            height={1}
            disabled={dismissing || dismissDisabled}
            onPress={onDismiss}
          />
        </Box>
      ) : null}
    </Box>
  );
}

export function OnboardingActions({ children }: { children: ReactNode }) {
  const desktop = useUiHost().kind === "desktop-web";
  return (
    <Box
      flexDirection="row"
      justifyContent={desktop ? "flex-end" : "flex-start"}
      alignItems="center"
      gap={1}
      style={desktop ? { marginTop: 14 } : undefined}
    >
      {children}
    </Box>
  );
}

export function OnboardingButton(props: ButtonProps) {
  return <Button {...props} height={props.height ?? 1} />;
}

export function OnboardingChoiceList({
  items,
  selectedIndex,
  onSelect,
  onActivate,
}: {
  items: ListViewItem[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onActivate: (index: number) => void;
}) {
  const colors = useThemeColors();
  const desktop = useUiHost().kind === "desktop-web";

  if (!desktop) {
    return (
      <Box flexDirection="column">
        {items.map((item, index) => {
          const selected = index === selectedIndex;
          const rowBg = selected ? colors.selected : colors.bg;
          return (
            <Box
              key={item.id}
              height={item.description ? 2 : 1}
              flexDirection="column"
              backgroundColor={rowBg}
              onMouseDown={() => {
                if (item.disabled) return;
                onSelect(index);
                onActivate(index);
              }}
            >
              <Box height={1} flexDirection="row" justifyContent="space-between">
                <Box flexDirection="row" flexGrow={1} minWidth={0} overflow="hidden">
                  <Text fg={selected ? colors.selectedText : colors.textDim}>{selected ? "▸ " : "  "}</Text>
                  <Text
                    fg={selected ? colors.textBright : colors.textDim}
                    attributes={selected ? TextAttributes.BOLD : 0}
                  >
                    {item.label}
                  </Text>
                </Box>
                {item.detail ? <Text fg={colors.textMuted}>{item.detail}</Text> : null}
              </Box>
              {item.description ? (
                <Box height={1} paddingLeft={2} overflow="hidden">
                  <Text fg={selected ? colors.text : colors.textMuted}>{item.description}</Text>
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>
    );
  }

  return (
    <ListView
      items={items}
      selectedIndex={selectedIndex}
      onSelect={onSelect}
      onActivate={(_item, index) => onActivate(index)}
      surface="framed"
      rowGap={0}
      rowHeight={2}
      selectOnHover
      renderRow={(item, state) => (
        <Box flexDirection="row" alignItems="center" width="100%" minWidth={0}>
          <Box flexDirection="column" flexGrow={1} minWidth={0}>
            <Text
              fg={state.selected ? colors.textBright : colors.text}
              attributes={state.selected ? TextAttributes.BOLD : 0}
              wrapText
            >
              {item.label}
            </Text>
            {item.description ? (
              <Text fg={colors.textMuted} wrapText>{item.description}</Text>
            ) : null}
          </Box>
          {item.detail ? (
            <Text fg={colors.borderFocused} attributes={TextAttributes.BOLD} style={{ marginLeft: 10 }}>
              {item.detail}
            </Text>
          ) : null}
        </Box>
      )}
    />
  );
}

export function OnboardingFeature({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const colors = useThemeColors();
  const desktop = useUiHost().kind === "desktop-web";
  if (!desktop) {
    return (
      <Box height={2} flexDirection="row" minWidth={0}>
        <Box width={2} height={1}><Text fg={colors.positive}>· </Text></Box>
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          <Box height={1} overflow="hidden"><Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{title}</Text></Box>
          <Box height={1} overflow="hidden"><Text fg={colors.textMuted}>{description}</Text></Box>
        </Box>
      </Box>
    );
  }
  return (
    <Box
      flexDirection="row"
      minWidth={0}
      style={desktop ? { alignItems: "flex-start" } : undefined}
    >
      <Box
        width="6px"
        height="6px"
        backgroundColor={colors.positive}
        style={{ borderRadius: 999, flexShrink: 0, marginTop: 6, marginRight: 10 }}
      />
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD} wrapText>
          {title}
        </Text>
        <Text fg={colors.textMuted} wrapText>
          {description}
        </Text>
      </Box>
    </Box>
  );
}
