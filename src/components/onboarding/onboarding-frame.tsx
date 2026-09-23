import type { ReactNode } from "react";
import { Box, Text, TextAttributes, useUiHost } from "../../ui";
import { useViewport } from "../../react/input";
import { blendHex } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { t } from "../../i18n";
import { Button, ListView, type ListViewItem } from "../ui";
import type { ButtonProps } from "../ui/button";
import { TITLEBAR_OVERLAY_HEIGHT_PX } from "../layout/titlebar-overlay";

/**
 * Spacing for the DOM card, in px. The card is a form the user fills in, not
 * pane chrome, so it does not sit on the terminal cell grid: an 8px rhythm with
 * one larger break before the footer.
 */
export const ONBOARDING_DESKTOP = {
  padding: "26px 28px 24px",
  radius: 10,
  afterProgress: 22,
  afterTitle: 6,
  afterHeader: 20,
  beforeFooter: 24,
  buttonHeight: "28px",
} as const;

export function OnboardingModal({
  children,
  width = 66,
  height = 18,
  desktopWidth,
}: {
  children: ReactNode;
  /** Terminal card width in cells. */
  width?: number;
  /** Terminal card height in rows; the DOM card sizes to its content. */
  height?: number;
  /** CSS width for the DOM card when a step needs more than the default surface. */
  desktopWidth?: string;
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
          style={{
            width: desktopWidth ?? "min(560px, 100%)",
            height: "auto",
            maxHeight: "calc(100vh - 88px)",
            padding: ONBOARDING_DESKTOP.padding,
            backgroundColor: blendHex(colors.panel, colors.bg, 0.12),
            borderRadius: ONBOARDING_DESKTOP.radius,
            // A hairline of light instead of a drawn border: the card reads as
            // a raised surface, not a box inside a box.
            boxShadow: `0 24px 64px color-mix(in srgb, ${colors.bg} 55%, transparent), 0 0 0 1px color-mix(in srgb, ${colors.textBright} 5%, transparent)`,
            boxSizing: "border-box",
            overflowY: "auto",
          }}
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
        // Wide enough for the primary action and its key on one line.
        width="min(432px, calc(100vw - 32px))"
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
  titleSuffix,
  description,
}: {
  step?: string;
  title: string;
  titlePrefix?: ReactNode;
  /** Short qualifier after the title, e.g. why a struck-through anchor price differs. */
  titleSuffix?: string;
  description?: string;
}) {
  const colors = useThemeColors();
  const desktop = useUiHost().kind === "desktop-web";

  if (desktop) {
    return (
      <Box flexDirection="column" style={{ marginTop: ONBOARDING_DESKTOP.afterProgress }}>
        {step ? (
          <Text
            fg={colors.borderFocused}
            attributes={TextAttributes.BOLD}
            style={{ fontSize: 11, letterSpacing: 0.6 }}
          >
            {step}
          </Text>
        ) : null}
        <Box
          flexDirection="row"
          alignItems="baseline"
          minWidth={0}
          style={{ marginTop: step ? 6 : 0, gap: 8 }}
        >
          {titlePrefix}
          <Text
            fg={colors.textBright}
            attributes={TextAttributes.BOLD}
            wrapText
            style={{ fontSize: 15, lineHeight: "20px" }}
          >
            {title}
          </Text>
          {titleSuffix ? <Text fg={colors.textMuted}>{titleSuffix}</Text> : null}
        </Box>
        {description ? (
          <Text
            fg={colors.textDim}
            wrapText
            style={{ marginTop: ONBOARDING_DESKTOP.afterTitle }}
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
      <Box height={1} flexDirection="row" gap={titlePrefix || titleSuffix ? 1 : 0}>
        {titlePrefix}
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{title}</Text>
        {titleSuffix ? <Text fg={colors.textMuted}>{titleSuffix}</Text> : null}
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
  dismissShortcut,
  dismissing = false,
  dismissDisabled = false,
  showDismiss = true,
}: {
  active?: OnboardingSectionId;
  available?: Partial<Record<OnboardingSectionId, boolean>>;
  onNavigate?: (section: OnboardingSectionId) => void;
  onDismiss: () => void;
  /** The key the wizard binds to Skip setup, shown on the button. */
  dismissShortcut?: string;
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
            shortcut={dismissShortcut}
            onPress={onDismiss}
          />
        ) : null}
      </Box>
    );
  }

  // Progress, not navigation: three segments, the current one lit, the ones
  // behind it filled. A filled segment is still a way back.
  const activeIndex = sections.findIndex((section) => section.id === active);
  return (
    <Box flexDirection="row" alignItems="flex-start" justifyContent="space-between" minWidth={0}>
      <Box flexDirection="row" style={{ gap: 10, width: 288, flexShrink: 0 }} data-gloom-role="onboarding-progress">
        {sections.map((section, index) => {
          const state = index === activeIndex ? "current" : index < activeIndex ? "done" : "upcoming";
          const clickable = state !== "current" && available?.[section.id] !== false && !!onNavigate;
          const bar = state === "current"
            ? colors.borderFocused
            : state === "done"
              ? colors.textDim
              : blendHex(colors.border, colors.bg, 0.3);
          const label = state === "current"
            ? colors.textBright
            : state === "done"
              ? colors.text
              : colors.textMuted;
          return (
            <Box
              key={section.id}
              flexDirection="column"
              flexGrow={1}
              minWidth={0}
              data-gloom-interactive={clickable ? "true" : undefined}
              // The wizard jumps to a section on its digit too.
              title={clickable ? `${section.label} (${index + 1})` : undefined}
              onMouseDown={clickable ? () => onNavigate?.(section.id) : undefined}
              style={{ gap: 6, cursor: clickable ? "pointer" : "default" }}
            >
              <Box style={{ height: 2, borderRadius: 1, backgroundColor: bar }} />
              <Text fg={label} style={{ fontSize: 11, lineHeight: "14px", fontWeight: state === "current" ? 700 : 500 }}>
                {section.label}
              </Text>
            </Box>
          );
        })}
      </Box>
      {showDismiss ? (
        <Box flexDirection="row" style={{ marginLeft: 12, marginTop: -6, flexShrink: 0 }}>
          <Button
            label={dismissing ? "Closing..." : "Skip setup"}
            variant="plain"
            height={1}
            disabled={dismissing || dismissDisabled}
            shortcut={dismissShortcut}
            onPress={onDismiss}
          />
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Footer row. On the DOM renderer the hint sits on the left and the buttons
 * on the right of the same line, so nothing floats. Terminal steps print
 * their hints in the body and ignore `hint`.
 */
export function OnboardingActions({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  const desktop = useUiHost().kind === "desktop-web";
  const colors = useThemeColors();
  if (desktop) {
    return (
      <Box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        minWidth={0}
        style={{ marginTop: ONBOARDING_DESKTOP.beforeFooter, gap: 16 }}
      >
        <Box flexDirection="row" alignItems="center" flexGrow={1} minWidth={0} overflow="hidden">
          {typeof hint === "string" ? <Text fg={colors.textMuted}>{hint}</Text> : hint}
        </Box>
        <Box flexDirection="row" alignItems="center" style={{ gap: 8, flexShrink: 0 }}>
          {children}
        </Box>
      </Box>
    );
  }
  return (
    <Box
      flexDirection="row"
      justifyContent="flex-start"
      alignItems="center"
      gap={1}
    >
      {children}
    </Box>
  );
}

export function OnboardingButton(props: ButtonProps) {
  const desktop = useUiHost().kind === "desktop-web";
  return <Button {...props} height={props.height ?? (desktop ? ONBOARDING_DESKTOP.buttonHeight : 1)} />;
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
