import { Box, Span, Text, TextAttributes, useShortcutLabel, useUiCapabilities } from "../../../../ui";
import { useRef } from "react";
import { colors, blendHex } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import { ShortcutHint } from "../../../ui/shortcut-hint";
import { keyHintWords } from "../../../ui/key-hint-words";
import { Button } from "../../../ui/button";
import { ChoiceDialog } from "../../../ui/choice-dialog";
import { Icon, IconButton } from "../../../ui/icon";
import { RemoteUiScope, useRemoteUiNode } from "../../../../remote/semantic-tree";
import { useOptionalDialog, type PromptContext } from "../../../../ui/dialog";
import { nativePaneFooterRows } from "../sizing";
import {
  EMPTY_FOOTER,
  desktopHintMetrics,
  PANE_FOOTER_SEPARATOR,
  fitPaneFooterInfo,
  separatesPaneFooterSegments,
  hasPaneFooterContent,
  layoutPaneFooterHintRow,
  paneFooterInfoWidth,
  paneHintTitle,
  terminalHintMetrics,
  totalHintsWidth,
  type CombinedPaneFooter,
  type PaneFooterPart,
  type PaneFooterSegment,
  type PaneHint,
} from "./model";
import { logFailure } from "../../../../utils/log-failure";

export {
  ageFooterSegment,
  companyDataFooterSegment,
  datesPaneData,
  DELAYED_SEGMENT,
  delayedFooterSegment,
  hasPaneFooterContent,
  savedCopyFooterInfo,
  savedCopyFooterSegment,
  splitDelayedStatus,
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
  usePaneMenuItems,
} from "./registration";

/** Terminal: blank cells between a framed footer's last hint and the frame's end. */
const FOOTER_FRAME_GAP = 1;

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

/** Columns an icon segment keeps when hints crowd the footer: in the terminal, what it draws (`◷15m`, `⚠[!]`). */
function iconSegmentReserve(segment: PaneFooterSegment, focused: boolean, nativePaneChrome: boolean): number {
  if (!segment.icon) return 0;
  if (nativePaneChrome) return 3;
  return Math.max(3, paneFooterInfoWidth([segment]) + terminalSegmentKey(segment, focused).length);
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

  if (nativePaneChrome && segment.icon && !segment.onPress) {
    // A status, not a control: the icon button's box, with its detail on hover.
    return (
      <Box
        role="img"
        aria-label={label}
        title={segment.title ?? label}
        data-gloom-role="pane-footer-icon"
        data-icon={segment.icon}
      >
        <Icon name={segment.icon} size={14} color={segment.disabled ? colors.textMuted : footerToneColor(segment.parts[0] ?? { text: "" })} />
      </Box>
    );
  }

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
      // The desktop shows a status the row clipped in full on hover.
      title={segment.title ?? label}
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

function usePaneHintRemoteNode(hint: PaneHint) {
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
      ...(hint.remoteScope ? { scope: hint.remoteScope } : {}),
    },
  });
}

function HintView({ hint, prefixSpace }: { hint: PaneHint; prefixSpace: boolean }) {
  usePaneHintRemoteNode(hint);
  return (
    <ShortcutHint
      hotkey={hint.key}
      label={hint.label}
      words={keyHintWords(hint)}
      prefix={prefixSpace ? " " : ""}
      disabled={hint.disabled}
      dataGloomRole="pane-hint"
      onPress={hint.onPress}
    />
  );
}

/** What sets a footer's hints apart on the desktop and the web: the gap a dialog's hints keep. */
const DESKTOP_HINT_GAP_STYLE = { marginLeft: "var(--gloom-space-md)" };

/** A hint behind More stays a remote control target, as it was when it only clipped. */
function OverflowHintNode({ hint }: { hint: PaneHint }) {
  usePaneHintRemoteNode(hint);
  return null;
}

function FooterOverflowMenu({ hints, width, label, nativePaneChrome }: { hints: PaneHint[]; width: number; label: string; nativePaneChrome: boolean }) {
  const dialog = useOptionalDialog();
  const keyLabel = useShortcutLabel();
  const open = () => {
    if (!dialog || hints.length === 0) return;
    // A list that holds a prompt's answers (Ask Gloom's Approve) is that
    // prompt's as a whole, so no assistant's UI call picks from it.
    const scope = hints.find((hint) => hint.remoteScope)?.remoteScope;
    void dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (context: PromptContext<string>) => {
        const choices = (
          <ChoiceDialog
            {...context}
            title={t("Pane actions")}
            // The desktop names each action as its menu does, with the key after it, never inside the word.
            choices={hints.map((hint, index) => ({
              id: String(index),
              label: nativePaneChrome ? paneHintTitle(hint) : `[${keyLabel(hint.key)}]${hint.label}`,
              ...(nativePaneChrome ? { detail: keyLabel(hint.key) } : {}),
              disabled: !hint.onPress,
            }))}
          />
        );
        return scope ? <RemoteUiScope scope={scope}>{choices}</RemoteUiScope> : choices;
      },
    }).then((selected) => {
      if (selected) hints[Number(selected)]?.onPress?.();
    }, logFailure("layout.pane-footer", "Open pane actions menu failed"));
  };
  return (
    <>
      <Button label={label} width={width} variant="plain" stopPropagation onPress={open} />
      {hints.map((hint) => <OverflowHintNode key={hint.id} hint={hint} />)}
    </>
  );
}

function FooterContent({
  footer,
  focused,
  width,
  showBackground = true,
  nativePaneChrome = false,
  trailingGap = 0,
}: {
  footer: CombinedPaneFooter;
  focused: boolean;
  width?: number;
  showBackground?: boolean;
  nativePaneChrome?: boolean;
  /** Blank cells of the band after the hints, past `width`, so they never touch the frame. */
  trailingGap?: number;
}) {
  const hasInfo = footer.info.length > 0;
  const actionableHints = focused ? footer.hints.filter((hint) => !hint.disabled) : [];
  const dividerColor = focused ? colors.borderFocused : colors.border;
  const backgroundColor = showBackground ? blendHex(colors.bg, dividerColor, focused ? 0.12 : 0.06) : undefined;
  const availableWidth = width && width > 0 ? Math.floor(width) : null;
  const iconReserve = footer.info.reduce((total, segment) => total + iconSegmentReserve(segment, focused, nativePaneChrome), 0);
  // Measured as the keys show: `[⌃S]` on a Mac takes fewer cells than `[Ctrl+S]`, and
  // on the desktop and the web as a keycap and the whole words, on the live grid.
  const keyLabel = useShortcutLabel();
  const { cellWidthPx = 8 } = useUiCapabilities();
  const metrics = nativePaneChrome ? desktopHintMetrics(cellWidthPx) : terminalHintMetrics(keyLabel);
  // A segment with shorter forms takes the longest that fits beside the hints, gaps and terminal keys included.
  const keysWidth = nativePaneChrome ? 0 : footer.info.reduce((total, segment) => total + terminalSegmentKey(segment, focused).length, 0);
  const row = availableWidth !== null
    ? layoutPaneFooterHintRow({ ...footer, hints: actionableHints }, availableWidth, iconReserve, metrics, { terminal: !nativePaneChrome, keysWidth })
    : null;
  const shownHints = row?.hints ?? actionableHints;
  const overflowHints = row?.overflow ?? [];
  const hasHints = shownHints.length > 0 || overflowHints.length > 0;
  const hintsWidth = hasHints ? (row?.hintsWidth ?? totalHintsWidth(shownHints, metrics)) : 0;
  const infoWidth = availableWidth !== null && hasInfo
    ? (row?.infoWidth ?? Math.max(0, availableWidth - hintsWidth))
    : undefined;
  const info = infoWidth != null ? fitPaneFooterInfo(footer.info, infoWidth - keysWidth, { besideHints: hasHints, terminal: !nativePaneChrome }) : footer.info;
  const lastTextIndex = info.findLastIndex((segment) => !segment.icon);

  if (!hasInfo && !hasHints) {
    return <Box flexGrow={1} height={1} />;
  }

  return (
    <Box
      height={1}
      flexGrow={1}
      // A box with a height does not shrink on the desktop unless it says so: this row has to follow
      // the pane's edge between two layouts, with the hints against it and the status giving way.
      flexShrink={nativePaneChrome ? 1 : undefined}
      flexDirection="row"
      justifyContent="space-between"
      overflow="hidden"
      paddingRight={trailingGap > 0 ? trailingGap : undefined}
      backgroundColor={backgroundColor}
    >
      {hasInfo && (
        <Box
          flexDirection="row"
          overflow="hidden"
          flexShrink={1}
          {...(infoWidth != null ? { width: infoWidth } : {})}
        >
          {info.map((segment, index) => {
            // Every pane's segments are set apart the same way, so two never read as one sentence.
            const separated = index > 0 && separatesPaneFooterSegments(info[index - 1]!, segment);
            return (
              <Box
                key={segment.id}
                flexDirection="row"
                overflow="hidden"
                // A row too narrow cuts from its end: the last text segment gives way, then the row clips the
                // one before it. An icon is a few cells that mean nothing cut, and earlier text says more.
                flexShrink={!segment.icon && index === lastTextIndex ? 1 : 0}
                marginLeft={index > 0 && !separated ? 1 : 0}
              >
                {separated && <Box flexShrink={0}><Text fg={colors.textMuted}>{PANE_FOOTER_SEPARATOR}</Text></Box>}
                <SegmentView segment={segment} focused={focused} />
              </Box>
            );
          })}
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
            {shownHints.map((hint, index) => (
              <Box key={hint.id} flexDirection="row" {...(nativePaneChrome ? { flexShrink: 0, ...(index > 0 ? { style: DESKTOP_HINT_GAP_STYLE } : {}) } : {})}>
                <HintView hint={hint} prefixSpace={index > 0} />
              </Box>
            ))}
            {overflowHints.length > 0 && row && (
              <Box
                flexShrink={0}
                {...(nativePaneChrome
                  ? (shownHints.length > 0 ? { style: DESKTOP_HINT_GAP_STYLE } : {})
                  : { marginLeft: shownHints.length > 0 ? 1 : 0 })}
              >
                <FooterOverflowMenu hints={overflowHints} width={row.moreWidth} label={row.moreLabel} nativePaneChrome={nativePaneChrome} />
              </Box>
            )}
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
          // The one hairline (styles.css), and no highlight under it.
          "--pane-footer-border-color": empty ? "transparent" : "var(--gloom-hairline)",
          borderTop: `1px solid ${empty ? "transparent" : "var(--gloom-hairline)"}`,
          backgroundColor: nativeBackgroundColor,
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
    // The row ends as the title bar does (` x ─┐`): the last hint, a blank, then the rule's last dash
    // and the corner, or the floating pane's `─◢` in the cells it reserves. A hint against the dash
    // read as one word (`ticker─`).
    const ruleEnd = reservedRight > 0 ? "" : "─┘";
    const rowWidth = Math.max(0, Math.floor(width) - 1 - reservedRight - ruleEnd.length);
    const contentWidth = Math.max(0, rowWidth - FOOTER_FRAME_GAP);
    return (
      <Box height={1} width={width} flexDirection="row" data-gloom-role="pane-footer" data-focused={focused ? "true" : "false"} data-empty={empty ? "true" : "false"}>
        <Text fg={borderColor} selectable={false}>└</Text>
        <Box width={rowWidth} height={1} overflow="hidden">
          {empty
            ? <Text fg={borderColor} selectable={false}>{"─".repeat(rowWidth)}</Text>
            : <FooterContent footer={resolvedFooter} focused={focused} width={contentWidth} trailingGap={rowWidth - contentWidth} />}
        </Box>
        {ruleEnd && <Text fg={borderColor} selectable={false}>{ruleEnd}</Text>}
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
