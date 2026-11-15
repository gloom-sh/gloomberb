import { useEffect, useMemo, useState } from "react";
import { Box, Text, useActionShortcut, useUiCapabilities } from "../../ui";
import { Button, terminalButtonColumns } from "../../components/ui/button";
import { TickerBadge } from "../../components/ticker/badge";
import { getTickerBadgeText, TICKER_BADGE_CHROME_WIDTH } from "../../components/ticker/badge/format";
import { t, tf } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { useQuoteEntries } from "../../market-data/hooks";
import { buildQuoteKey, resolveEntryData } from "../../market-data/selectors";
import { useViewport } from "../../react/input";
import { useThemeColors } from "../../theme/theme-context";
import type { Quote } from "../../types/financials";
import { displayWidth } from "../../utils/format";
import { bindSinceLastVisitKeys } from "./keys";
import { formatVisitTime, liveMovePercent, type VisitMove } from "./model";
import type { SinceLastVisit, SinceLastVisitMove } from "./use-since-last-visit";

/** Cells between the lead and the chips, and between the two actions. */
const GAP = 2;
/** A window this wide (in cells) says "since your last visit" in full on the desktop and the web. */
const NATIVE_FULL_LEAD_COLUMNS = 110;

interface StripChip {
  move: VisitMove;
  percent: number;
  quote: Quote | null;
}

interface TerminalFit {
  lead: string;
  chips: number;
  /** Hide says its key. */
  hideKey: boolean;
  turnOff: boolean;
}

/**
 * What the terminal's one row has room for. The date of the last visit (the
 * short lead), Hide and one move always stay: a move without its date would
 * read as the day's. Turn off stays next, as long as a move fits beside it
 * (the command bar's Since Last Visit has it too); then as many moves as fit,
 * biggest first; then Hide's key; then the lead in full.
 */
function fitTerminalStrip(
  width: number,
  [fullLead, shortLead]: readonly [string, string],
  chipColumns: readonly number[],
  hideColumns: { withKey: number; bare: number },
  turnOffColumns: number,
): TerminalFit {
  const fit = (option: Omit<TerminalFit, "chips">): TerminalFit => {
    // One cell of padding at each edge, a gap after the lead and before each action.
    let room = width - 2 - displayWidth(option.lead) - GAP
      - GAP - (option.hideKey ? hideColumns.withKey : hideColumns.bare)
      - (option.turnOff ? GAP + turnOffColumns : 0);
    let chips = 0;
    for (const columns of chipColumns) {
      if (columns > room) break;
      room -= columns;
      chips += 1;
    }
    return { ...option, chips };
  };
  const withTurnOff = [
    fit({ lead: fullLead, hideKey: true, turnOff: true }),
    fit({ lead: shortLead, hideKey: true, turnOff: true }),
    fit({ lead: shortLead, hideKey: false, turnOff: true }),
  ];
  const whole = withTurnOff.find((option) => option.chips === chipColumns.length);
  if (whole) return whole;
  const most = withTurnOff.reduce((best, option) => (option.chips > best.chips ? option : best));
  return most.chips > 0 ? most : fit({ lead: shortLead, hideKey: false, turnOff: false });
}

/**
 * The strip a returning user sees above the layout: when they were last
 * here, then what moved most in their own portfolios and watchlists since,
 * each a ticker chip that opens its research. Hide puts it away for this
 * session (the notification dismiss key too); Turn off puts it away for good,
 * until Since Last Visit in the command bar turns it on again.
 */
export function SinceLastVisitStrip({ strip }: { strip: SinceLastVisit }) {
  useAppLanguage();
  const colors = useThemeColors();
  const { nativePaneChrome = false } = useUiCapabilities();
  const { width } = useViewport();
  const dismissKey = useActionShortcut("notification-dismiss");
  // The chip under the pointer says its price, as ticker chips do.
  const [hovered, setHovered] = useState<string | null>(null);
  const recap = strip.recap;
  const moves: readonly SinceLastVisitMove[] = recap?.moves ?? [];
  const entries = useQuoteEntries(useMemo(() => moves.map((entry) => entry.instrument), [moves]));
  const now = Date.now();
  const chips = moves.flatMap<StripChip>(({ move, instrument }) => {
    const quote = resolveEntryData(entries.get(buildQuoteKey(instrument))) ?? null;
    const percent = liveMovePercent(move, quote, now);
    return percent == null ? [] : [{ move, percent, quote }];
  });
  const first = chips[0]?.move ?? null;

  useEffect(() => {
    if (!first) return;
    strip.noteShown();
    return bindSinceLastVisitKeys({ open: () => strip.open(first), dismiss: strip.hide });
  }, [first, strip]);
  // Every move it named stopped comparing (a currency or a split changed under it): nothing is left to say.
  const exhausted = !!recap && chips.length === 0;
  useEffect(() => {
    if (exhausted) strip.hide();
  }, [exhausted, strip]);

  if (!recap || chips.length === 0) return null;

  const when = formatVisitTime(recap.seenAt, now);
  const fullLead = tf("Since your last visit, {time}", { time: when });
  const shortLead = tf("Since {time}", { time: when });
  const hideButton = { label: "Hide", compact: true, shortcut: dismissKey || undefined } as const;
  const bareHideButton = { label: "Hide", compact: true } as const;
  const turnOffButton = { label: "Turn off", compact: true } as const;
  const chipText = (chip: StripChip) => getTickerBadgeText({ symbol: chip.move.symbol, status: "ready", quote: chip.quote, move: chip.percent });

  // The desktop and the web lay the chips out in CSS: one that has no room wraps out of sight.
  const fit: TerminalFit = nativePaneChrome
    ? { lead: width >= NATIVE_FULL_LEAD_COLUMNS ? fullLead : shortLead, chips: chips.length, hideKey: true, turnOff: true }
    : fitTerminalStrip(
      width,
      [fullLead, shortLead],
      chips.map((chip) => displayWidth(chipText(chip)) + TICKER_BADGE_CHROME_WIDTH),
      { withKey: terminalButtonColumns(hideButton), bare: terminalButtonColumns(bareHideButton) },
      terminalButtonColumns(turnOffButton),
    );

  const chipNodes = chips.slice(0, fit.chips).map((chip) => (
    <TickerBadge
      key={chip.move.key}
      symbol={chip.move.symbol}
      status="ready"
      quote={chip.quote}
      move={chip.percent}
      hovered={hovered === chip.move.key}
      onHoverStart={() => setHovered(chip.move.key)}
      onHoverEnd={() => setHovered((current) => (current === chip.move.key ? null : current))}
      onOpen={() => strip.open(chip.move)}
    />
  ));

  return (
    <Box
      flexDirection="row"
      height={1}
      alignItems="center"
      flexShrink={0}
      backgroundColor={colors.panel}
      data-gloom-role="since-last-visit"
      style={nativePaneChrome ? { paddingInline: "var(--gloom-inset)", gap: "var(--gloom-space-sm)" } : undefined}
      paddingX={nativePaneChrome ? undefined : 1}
    >
      <Box flexShrink={0} paddingRight={nativePaneChrome ? undefined : GAP}>
        <Text fg={colors.textDim}>{fit.lead}</Text>
      </Box>
      <Box
        flexDirection="row"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        overflow="hidden"
        // A chip the window has no room for wraps out of sight rather than being cut.
        style={nativePaneChrome ? { flexWrap: "wrap", height: "100%", alignContent: "flex-start" } : undefined}
      >
        {chipNodes}
      </Box>
      <Box
        flexDirection="row"
        flexShrink={0}
        paddingLeft={nativePaneChrome ? undefined : GAP}
        style={nativePaneChrome ? { gap: "var(--gloom-space-sm)" } : undefined}
      >
        <Button
          {...(fit.hideKey ? hideButton : bareHideButton)}
          variant="plain"
          title={t("Hide until you next open Gloom")}
          stopPropagation
          onPress={strip.hide}
        />
        {fit.turnOff ? (
          <Box paddingLeft={nativePaneChrome ? undefined : GAP}>
            <Button {...turnOffButton} variant="plain" title={t("Stop showing what moved since your last visit")} stopPropagation onPress={strip.turnOff} />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
