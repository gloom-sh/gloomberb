import { Box, Span, Text, TextAttributes, useUiCapabilities } from "../../../../ui";
import { useRef } from "react";
import { colors, blendHex } from "../../../../theme/colors";
import { getShortcutHintWidth, ShortcutHint } from "../../../ui/shortcut-hint";
import { IconButton } from "../../../ui/icon";
import { useRemoteUiNode } from "../../../../remote/semantic-tree";
import { nativePaneFooterRows } from "../sizing";
import {
  EMPTY_FOOTER,
  hasPaneFooterContent,
  type CombinedPaneFooter,
  type PaneFooterPressEvent,
  type PaneFooterPart,
  type PaneFooterSegment,
  type PaneHint,
} from "./model";

export {
  paneHintTitle,
  hasPaneFooterContent,
  type CombinedPaneFooter,
  type PaneFooterPressEvent,
  type PaneFooterSegment,
  type PaneHint,
} from "./model";
export { getPaneFooter, PaneFooterKeys } from "./keyboard";
export {
  PaneFooterProvider,
  PaneFooterScope,
  usePaneFooter,
  usePaneHints,
  usePaneMenuItems,
} from "./registration";

function footerToneColor(part: PaneFooterPart): string {
  if (part.color) return part.color;
  switch (part.tone) {
    case "label":
      return colors.textDim;
    case "muted":
      return colors.textMuted;
    case "positive":
      return colors.positive;
    case "negative":
      return colors.negative;
    case "warning":
      return colors.warning;
    case "value":
    default:
      return colors.text;
  }
}

function stopMouseEvent(event?: { stopPropagation?: () => void; preventDefault?: () => void }) {
  event?.stopPropagation?.();
  event?.preventDefault?.();
}

/**
 * The key the terminal draws after an icon segment while its pane is focused
 * (`⚠[!]`), since a glyph has no tooltip there. The desktop shows it in the
 * icon's tooltip instead.
 */
function terminalSegmentKey(segment: PaneFooterSegment, focused: boolean): string {
  return focused && segment.icon && segment.shortcut && segment.onPress && !segment.disabled
    ? `[${segment.shortcut}]`
    : "";
}

/** Columns an icon segment keeps when hints crowd the footer. */
function iconSegmentReserve(segment: PaneFooterSegment, focused: boolean, nativePaneChrome: boolean): number {
  if (!segment.icon) return 0;
  return nativePaneChrome ? 3 : Math.max(3, 1 + terminalSegmentKey(segment, focused).length);
}

function SegmentView({ segment, focused }: { segment: PaneFooterSegment; focused: boolean }) {
  const { nativePaneChrome } = useUiCapabilities();
  const interactive = !!segment.onPress && !segment.disabled;
  const keyText = nativePaneChrome ? "" : terminalSegmentKey(segment, focused);
  const label = segment.label ?? segment.parts.map((part) => part.text).join(" ");
  useRemoteUiNode(interactive ? {
    role: "pane-footer-segment",
    label,
    disabled: segment.disabled,
    actions: {
      press: () => segment.onPress?.(),
    },
    metadata: { id: segment.id, title: segment.title, shortcut: segment.shortcut },
  } : null);
  const attributes = segment.parts.some((part) => part.bold) || interactive ? TextAttributes.BOLD : 0;
  const triggerMouseDownRef = useRef(false);
  const startSegmentPress = (event?: { stopPropagation?: () => void; preventDefault?: () => void }) => {
    triggerMouseDownRef.current = true;
    stopMouseEvent(event);
  };
  const finishSegmentPress = (event?: { stopPropagation?: () => void; preventDefault?: () => void }) => {
    const startedOnTrigger = triggerMouseDownRef.current;
    triggerMouseDownRef.current = false;
    if (startedOnTrigger) segment.onPress?.();
    else stopMouseEvent(event);
  };

  if (nativePaneChrome && segment.icon) {
    return (
      <IconButton
        icon={segment.icon}
        label={label}
        title={segment.title ?? label}
        shortcut={segment.shortcut}
        hasPopup={interactive ? "dialog" : undefined}
        size={14}
        disabled={!interactive}
        color={segment.disabled ? colors.textMuted : footerToneColor(segment.parts[0] ?? { text: "" })}
        onPress={() => segment.onPress?.()}
      />
    );
  }

  return (
    <Text
      fg={segment.disabled ? colors.textMuted : colors.textDim}
      attributes={attributes}
      aria-label={segment.label}
      title={segment.title}
      cursor={interactive ? "pointer" : undefined}
      onMouseDown={interactive ? startSegmentPress : undefined}
      onMouseUp={interactive ? finishSegmentPress : undefined}
      {...(interactive ? { "data-gloom-interactive": "true" } : {})}
    >
      {[
        ...segment.parts.map((part, index) => (
          <Span
            key={`${segment.id}:part:${index}`}
            fg={segment.disabled ? colors.textMuted : footerToneColor(part)}
            attributes={part.bold ? TextAttributes.BOLD : 0}
          >
            {index > 0 ? " " : ""}{part.text}
          </Span>
        )),
        ...(keyText
          ? [<Span key={`${segment.id}:key`} fg={colors.textBright} attributes={TextAttributes.BOLD}>{keyText}</Span>]
          : []),
      ]}
    </Text>
  );
}

function hintTextLength(hint: PaneHint, index: number): number {
  return getShortcutHintWidth(hint.key, hint.label, index > 0 ? " " : "");
}

function totalHintsWidth(hints: PaneHint[]): number {
  return hints.reduce((total, hint, index) => total + hintTextLength(hint, index), 0);
}

function HintView({ hint, prefixSpace }: { hint: PaneHint; prefixSpace: boolean }) {
  useRemoteUiNode({
    role: "pane-hint",
    label: `${hint.key}${hint.label}`,
    disabled: hint.disabled,
    actions: {
      press: hint.onPress ? () => hint.onPress?.() : undefined,
    },
    metadata: {
      id: hint.id,
      key: hint.key,
      label: hint.label,
    },
  });
  return (
    <ShortcutHint
      hotkey={hint.key}
      label={hint.label}
      prefix={prefixSpace ? " " : ""}
      disabled={hint.disabled}
      dataGloomRole="pane-hint"
      onPress={hint.onPress}
    />
  );
}

function FooterContent({
  footer,
  focused,
  width,
  showBackground = true,
  nativePaneChrome = false,
}: {
  footer: CombinedPaneFooter;
  focused: boolean;
  width?: number;
  showBackground?: boolean;
  nativePaneChrome?: boolean;
}) {
  const hasInfo = footer.info.length > 0;
  const visibleHints = focused ? footer.hints.filter((hint) => !hint.disabled) : [];
  const hasHints = visibleHints.length > 0;
  const dividerColor = focused ? colors.borderFocused : colors.border;
  const backgroundColor = showBackground ? blendHex(colors.bg, dividerColor, focused ? 0.12 : 0.06) : undefined;
  const availableWidth = width && width > 0 ? Math.floor(width) : null;
  const iconReserve = footer.info.reduce((total, segment) => total + iconSegmentReserve(segment, focused, nativePaneChrome), 0);
  const hintsWidth = hasHints
    ? Math.min(availableWidth === null ? totalHintsWidth(visibleHints) : Math.max(0, availableWidth - iconReserve), totalHintsWidth(visibleHints))
    : 0;
  const infoWidth = availableWidth !== null && hasInfo
    ? Math.max(0, availableWidth - hintsWidth)
    : undefined;

  if (!hasInfo && !hasHints) {
    return <Box flexGrow={1} height={1} />;
  }

  return (
    <Box
      height={1}
      flexGrow={1}
      flexDirection="row"
      justifyContent="space-between"
      overflow="hidden"
      backgroundColor={backgroundColor}
    >
      {hasInfo && (
        <Box
          flexDirection="row"
          overflow="hidden"
          flexShrink={1}
          {...(infoWidth != null ? { width: infoWidth } : {})}
        >
          {footer.info.map((segment, index) => (
            <Box key={segment.id} flexDirection="row" marginRight={index === footer.info.length - 1 ? 0 : 1}>
              <SegmentView segment={segment} focused={focused} />
            </Box>
          ))}
        </Box>
      )}
      {hasHints && (
        <>
          <Box flexGrow={1} />
          <Box
            flexDirection="row"
            justifyContent="flex-end"
            flexShrink={0}
            overflow="hidden"
            {...(availableWidth !== null ? { width: hintsWidth } : { flexGrow: 1 })}
          >
            {visibleHints.map((hint, index) => (
              <Box key={hint.id} flexDirection="row">
                <HintView hint={hint} prefixSpace={index > 0} />
              </Box>
            ))}
          </Box>
        </>
      )}
    </Box>
  );
}

export function PaneFooterBar({
  footer = EMPTY_FOOTER,
  focused,
  width = 0,
  reserveRight = 0,
  showBorder = false,
}: {
  footer?: CombinedPaneFooter | null;
  focused: boolean;
  width?: number;
  reserveRight?: number;
  showBorder?: boolean;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const resolvedFooter = footer ?? EMPTY_FOOTER;
  const empty = !hasPaneFooterContent(resolvedFooter);
  const borderColor = focused ? colors.borderFocused : colors.border;
  const topBorderColor = colors.border;
  const nativeBackgroundColor = empty
    ? "transparent"
    : focused
      ? blendHex(colors.bg, colors.borderFocused, 0.06)
      : blendHex(colors.panel, colors.border, 0.12);
  const reservedRight = Math.max(0, reserveRight);
  const rightPadding = reservedRight > 0 ? reservedRight : 1;

  if (nativePaneChrome) {
    return (
      <Box
        height={nativePaneFooterRows()}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={rightPadding}
        alignItems="center"
        data-gloom-role="pane-footer"
        data-focused={focused ? "true" : "false"}
        data-empty={empty ? "true" : "false"}
        style={{
          "--pane-footer-border-color": empty ? "transparent" : topBorderColor,
          borderTop: `1px solid ${empty ? "transparent" : topBorderColor}`,
          backgroundColor: nativeBackgroundColor,
          boxShadow: empty ? "none" : `inset 0 1px 0 ${blendHex(nativeBackgroundColor, colors.textBright, 0.03)}`,
        }}
      >
        <FooterContent
          footer={resolvedFooter}
          focused={focused}
          width={width > 0 ? Math.max(0, Math.floor(width) - rightPadding - 1) : undefined}
          showBackground={false}
          nativePaneChrome
        />
      </Box>
    );
  }

  if (focused || showBorder) {
    const contentWidth = Math.max(0, Math.floor(width) - 1 - reservedRight - (reservedRight > 0 ? 0 : 1));
    return (
      <Box height={1} width={width} flexDirection="row" data-gloom-role="pane-footer" data-focused={focused ? "true" : "false"} data-empty={empty ? "true" : "false"}>
        <Text fg={borderColor} selectable={false}>└</Text>
        <Box width={contentWidth} height={1} overflow="hidden">
          {empty
            ? <Text fg={borderColor} selectable={false}>{"─".repeat(contentWidth)}</Text>
            : <FooterContent footer={resolvedFooter} focused={focused} width={contentWidth} />}
        </Box>
        {reservedRight === 0 && <Text fg={borderColor} selectable={false}>┘</Text>}
      </Box>
    );
  }

  const contentWidth = Math.max(0, Math.floor(width) - reservedRight);
  return (
    <Box height={1} width={width} flexDirection="row" data-gloom-role="pane-footer" data-focused="false" data-empty={empty ? "true" : "false"}>
      <Box width={contentWidth} height={1} overflow="hidden">
        <FooterContent footer={resolvedFooter} focused={false} width={contentWidth} />
      </Box>
    </Box>
  );
}
