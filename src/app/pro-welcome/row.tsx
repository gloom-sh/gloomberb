import { useEffect } from "react";
import { Box, Text, useActionShortcut, useUiCapabilities } from "../../ui";
import { Button, terminalButtonColumns } from "../../components/ui/button";
import { DesktopPaneLinkChip, TerminalPaneLinkChip } from "../../components/ui/pane-link-chip";
import { t, tf } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { useViewport } from "../../react/input";
import { useThemeColors } from "../../theme/theme-context";
import { displayWidth } from "../../utils/format";
import { bindProWelcomeKeys } from "./keys";
import type { ProWelcomeChip } from "./model";
import type { ProWelcome } from "./use-pro-welcome";

/** Cells between the lead and the chips, and before Dismiss. */
const GAP = 2;
/** A window this wide (in cells) says the lead and the functions in full on the desktop and the web. */
const NATIVE_FULL_COLUMNS = 110;

interface RowFit {
  lead: string;
  /** Functions by their mnemonic (`CALLS · AAPL`) rather than their name. */
  short: boolean;
  chips: number;
  dismissKey: boolean;
}

/** What a chip says: the function and the ticker it opens on, short as the command itself (`CALLS AAPL`). */
function chipText(chip: ProWelcomeChip, short: boolean): string {
  return short ? `${chip.fn.shortcut} ${chip.symbol}` : `${t(chip.fn.label)} · ${chip.symbol}`;
}

/** The chip's lead square: the function's letter, as its pane's chip has. */
function chipIcon(chip: ProWelcomeChip): string {
  return chip.fn.shortcut.slice(0, 1);
}

/** A terminal chip's cells: its square, its words and the space after them, then one between chips. */
function terminalChipColumns(chip: ProWelcomeChip, short: boolean): number {
  return displayWidth(` ${chipIcon(chip)} `) + displayWidth(chipText(chip, short)) + 1 + 1;
}

/**
 * What the terminal's one row has room for: a lead and Dismiss always; then
 * every function by its name, else by its command, else as many as fit;
 * then Dismiss's key; then the lead in full. A window too narrow for any
 * function says the least lead and one command when one fits.
 */
function fitTerminalRow(
  width: number,
  chips: readonly ProWelcomeChip[],
  [fullLead, shortLead, tinyLead]: readonly [string, string, string],
  dismissColumns: { withKey: number; bare: number },
): RowFit {
  const fit = (option: Omit<RowFit, "chips">): RowFit => {
    let room = width - 2 - displayWidth(option.lead) - GAP - GAP
      - (option.dismissKey ? dismissColumns.withKey : dismissColumns.bare);
    let count = 0;
    for (const chip of chips) {
      const columns = terminalChipColumns(chip, option.short);
      if (columns > room) break;
      room -= columns;
      count += 1;
    }
    return { ...option, chips: count };
  };
  const options = [
    fit({ lead: fullLead, short: false, dismissKey: true }),
    fit({ lead: shortLead, short: false, dismissKey: true }),
    fit({ lead: shortLead, short: true, dismissKey: true }),
    fit({ lead: shortLead, short: true, dismissKey: false }),
    fit({ lead: tinyLead, short: true, dismissKey: false }),
  ];
  const whole = options.find((option) => option.chips === chips.length);
  if (whole) return whole;
  const most = options.reduce((best, option) => (option.chips > best.chips ? option : best));
  return most.chips > 0 ? most : options.at(-1)!;
}

/**
 * The row someone new to Pro sees under the header, through their trial and
 * their first two paid weeks: a few Pro functions they have not opened, each
 * a chip that opens it on one of their own tickers. Dismiss puts it away for good on this machine (the
 * notification dismiss key too; the notification action key opens the first).
 */
export function ProWelcomeRow({ welcome }: { welcome: ProWelcome }) {
  useAppLanguage();
  const colors = useThemeColors();
  const { nativePaneChrome = false } = useUiCapabilities();
  const { width } = useViewport();
  const dismissKey = useActionShortcut("notification-dismiss");
  const chips = welcome.chips ?? [];
  const first = chips[0] ?? null;

  useEffect(() => {
    if (!first) return;
    return bindProWelcomeKeys({ open: () => welcome.open(first), dismiss: welcome.dismiss });
  }, [first, welcome]);

  if (chips.length === 0) return null;

  const fullLead = t("Try Pro on your tickers");
  const shortLead = t("Try Pro");
  const tinyLead = "Pro";
  const dismissButton = { label: "Dismiss", compact: true, shortcut: dismissKey || undefined } as const;
  const bareDismissButton = { label: "Dismiss", compact: true } as const;
  const wide = width >= NATIVE_FULL_COLUMNS;
  // The desktop and the web lay the chips out in CSS: one that has no room wraps out of sight.
  const fit: RowFit = nativePaneChrome
    ? { lead: wide ? fullLead : shortLead, short: !wide, chips: chips.length, dismissKey: true }
    : fitTerminalRow(
      width,
      chips,
      [fullLead, shortLead, tinyLead],
      { withKey: terminalButtonColumns(dismissButton), bare: terminalButtonColumns(bareDismissButton) },
    );

  const chipNodes = chips.slice(0, fit.chips).map((chip) => {
    const command = `${chip.fn.shortcut} ${chip.symbol}`;
    return nativePaneChrome ? (
      <DesktopPaneLinkChip
        key={chip.fn.templateId}
        content={{ title: chipText(chip, fit.short), detail: "", icon: chipIcon(chip) }}
        variant="inline"
        onOpen={() => welcome.open(chip)}
        tooltip={tf("Open {command}", { command })}
        role="pro-welcome-chip"
        linkKey={`pro-welcome:${chip.fn.shortcut}`}
      />
    ) : (
      <Box key={chip.fn.templateId} paddingRight={1}>
        <TerminalPaneLinkChip
          content={{ title: chipText(chip, fit.short), detail: "", icon: chipIcon(chip) }}
          width={terminalChipColumns(chip, fit.short) - 1}
          onOpen={() => welcome.open(chip)}
        />
      </Box>
    );
  });

  return (
    <Box
      flexDirection="row"
      height={1}
      alignItems="center"
      flexShrink={0}
      backgroundColor={colors.panel}
      data-gloom-role="pro-welcome"
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
        style={nativePaneChrome ? { flexWrap: "wrap", height: "100%", alignContent: "flex-start", alignItems: "center", gap: "var(--gloom-space-sm)" } : undefined}
      >
        {chipNodes}
      </Box>
      <Box flexDirection="row" flexShrink={0} paddingLeft={nativePaneChrome ? undefined : GAP}>
        <Button
          {...(fit.dismissKey ? dismissButton : bareDismissButton)}
          variant="plain"
          title={t("Stop suggesting Pro functions")}
          stopPropagation
          onPress={welcome.dismiss}
        />
      </Box>
    </Box>
  );
}
