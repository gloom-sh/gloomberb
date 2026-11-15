import { useEffect, useMemo } from "react";
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
  lead: string | null;
  chips: number;
  turnOff: boolean;
}

/**
 * What the terminal's one row has room for, most first: the lead in full,
 * then short, then without Turn off (the command bar's Since Last Visit
 * still has it), then without a lead. Every chip that fits is shown, the
 * biggest moves first; Hide always stays.
 */
export function fitTerminalStrip(
  width: number,
  leads: readonly string[],
  chipColumns: readonly number[],
  hideColumns: number,
  turnOffColumns: number,
): TerminalFit {
  const options: Array<{ lead: string | null; turnOff: boolean }> = [
    ...leads.map((lead) => ({ lead, turnOff: true })),
    ...leads.slice(-1).map((lead) => ({ lead, turnOff: false })),
    { lead: null, turnOff: false },
  ];
  let best: TerminalFit = { lead: null, chips: 0, turnOff: false };
  for (const option of options) {
    // One cell of padding at each edge, a gap before the actions.
    let room = width - 2 - hideColumns - GAP
      - (option.turnOff ? GAP + turnOffColumns : 0)
      - (option.lead ? displayWidth(option.lead) + GAP : 0);
    let chips = 0;
    for (const columns of chipColumns) {
      if (columns > room) break;
      room -= columns;
      chips += 1;
    }
    if (chips === chipColumns.length) return { ...option, chips };
    if (chips > best.chips) best = { ...option, chips };
  }
  return best;
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
  const turnOffButton = { label: "Turn off", compact: true } as const;
  const chipText = (chip: StripChip) => getTickerBadgeText({ symbol: chip.move.symbol, status: "ready", quote: chip.quote, move: chip.percent });

  const fit = nativePaneChrome
    ? { lead: width >= NATIVE_FULL_LEAD_COLUMNS ? fullLead : shortLead, chips: chips.length, turnOff: true }
    : fitTerminalStrip(
      width,
      [fullLead, shortLead],
      chips.map((chip) => displayWidth(chipText(chip)) + TICKER_BADGE_CHROME_WIDTH),
      terminalButtonColumns(hideButton),
      terminalButtonColumns(turnOffButton),
    );

  const chipNodes = chips.slice(0, fit.chips).map((chip) => (
    <TickerBadge
      key={chip.move.key}
      symbol={chip.move.symbol}
      status="ready"
      quote={chip.quote}
      move={chip.percent}
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
      {fit.lead ? (
        <Box flexShrink={0} paddingRight={nativePaneChrome ? undefined : GAP}>
          <Text fg={colors.textDim}>{fit.lead}</Text>
        </Box>
      ) : null}
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
      <Box flexDirection="row" flexShrink={0} paddingLeft={nativePaneChrome ? undefined : GAP}>
        <Button {...hideButton} variant="plain" title={t("Hide until you next open Gloom")} stopPropagation onPress={strip.hide} />
        {fit.turnOff ? (
          <Box paddingLeft={nativePaneChrome ? undefined : GAP} style={nativePaneChrome ? { marginLeft: "var(--gloom-space-sm)" } : undefined}>
            <Button {...turnOffButton} variant="plain" title={t("Stop showing what moved since your last visit")} stopPropagation onPress={strip.turnOff} />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
