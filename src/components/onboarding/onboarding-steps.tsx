import { useMemo } from "react";
import { AsciiText, Box, Span, Strong, Text, TextAttributes, useUiHost } from "../../ui";
import { colors } from "../../theme/colors";
import { t, tf } from "../../i18n";
import { themes } from "../../theme/themes";
import { detectShortcutPlatform, formatPrimaryShortcut, getShortcutDisplayMode } from "../../utils/shortcut-labels";
import { ListView, type ListViewItem } from "../ui";
import type { AccountOutcome } from "./account-step/model";
export { PortfolioStep, type PortfolioSub } from "./portfolio-step";
export { AccountStep } from "./account-step";

export interface BrokerSyncSummary {
  portfolioId: string | null;
  positionsImported: number;
}

const LOGO_TEXT = "Gloomberb";

export function WelcomeStep() {
  return (
    <Box flexDirection="column" paddingX={2}>
      <Box height={1} />
      <AsciiText text={LOGO_TEXT} font="wordmark" color={colors.textBright} />
      <Box height={2} />
      <Box height={1}>
        <Text fg={colors.textDim}>{t("The open terminal for modern finance.")}</Text>
      </Box>
      <Box height={2} />
      <Box height={1}>
        <Text fg={colors.textMuted}>{t("Let's set things up (~30s).")}</Text>
      </Box>
      <Box height={2} />
    </Box>
  );
}

// Rows the theme step spends on everything that is not the theme list itself.
const THEME_CHROME_ROWS = 8;

export function ThemeStep({
  themeIds,
  selectedIdx,
  onSelect,
  height,
}: {
  themeIds: string[];
  selectedIdx: number;
  onSelect: (index: number) => void;
  height: number;
}) {
  const items = useMemo<ListViewItem[]>(
    () => themeIds.map((id) => ({ id, label: themes[id]!.name })),
    [themeIds],
  );

  return (
    <Box flexDirection="column" paddingX={2}>
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{t("Theme")}</Text>
      </Box>
      <Box height={1} />
      <Box height={1} flexDirection="row">
        <Text fg={colors.textDim}>{t("Change it later from the command bar with ")}</Text>
        <Text fg={colors.text} attributes={TextAttributes.BOLD}>{"TH"}</Text>
      </Box>
      <Box height={1} />
      <Box height={1} flexDirection="row">
        <Text fg={colors.positive}>{" \u2588\u2588 "}</Text>
        <Text fg={colors.negative}>{" \u2588\u2588 "}</Text>
        <Text fg={colors.text}>{" \u2588\u2588 "}</Text>
        <Text fg={colors.textBright}>{" \u2588\u2588 "}</Text>
        <Text fg={colors.borderFocused}>{" \u2588\u2588 "}</Text>
        <Text fg={colors.textDim}>{" \u2588\u2588 "}</Text>
      </Box>
      <Box height={1} />

      <ListView
        items={items}
        selectedIndex={selectedIdx}
        onSelect={onSelect}
        scrollable
        height={Math.max(3, height - THEME_CHROME_ROWS)}
      />

      <Box height={1} />
      <Box height={1}>
        <Text fg={colors.textMuted}>{t("Use \u2191\u2193 to browse")}</Text>
      </Box>
    </Box>
  );
}

export function ShortcutsStep({ height }: { height: number }) {
  const uiHost = useUiHost();
  const shortcutPlatform = detectShortcutPlatform();
  const shortcutDisplayMode = getShortcutDisplayMode(uiHost.kind);
  const platformShortcut = (keys: string | readonly string[]) => formatPrimaryShortcut(keys, shortcutPlatform, shortcutDisplayMode);
  const keyboardShortcuts = [
    { key: "Ctrl+P", desc: t("Open command mode") },
    { key: "`", desc: t("Open ticker search") },
    { key: "Tab", desc: t("Switch between panels") },
    { key: platformShortcut("W"), desc: t("Close the focused pane") },
    { key: platformShortcut(["Shift", "D"]), desc: t("Dock or float the focused pane") },
    { key: "q", desc: t("Quit") },
  ];

  const commandPrefixes = [
    { key: "DES AAPL", desc: t("Open security details") },
    { key: "TH", desc: t("Switch theme") },
    { key: "PL", desc: t("Toggle plugins") },
    { key: "HELP", desc: t("Open the help window") },
  ];

  const COL = 20;

  // Shed the least useful rows first so the wizard footer stays on screen in an 80x24 terminal.
  const gap = height < 21 ? 1 : 2;
  const showTagline = height >= 19;
  const showPrefixHint = height >= 17;

  return (
    <Box flexDirection="column" paddingX={2}>
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{t("After launch shortcuts")}</Text>
      </Box>
      <Box height={1} />

      {keyboardShortcuts.map((shortcut) => (
        <Box key={shortcut.key} height={1} flexDirection="row">
          <Text fg={colors.text} attributes={TextAttributes.BOLD}>{shortcut.key.padEnd(COL)}</Text>
          <Text fg={colors.textDim}>{shortcut.desc}</Text>
        </Box>
      ))}

      <Box height={gap} />
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{t("Basic command prefixes")}</Text>
      </Box>
      <Box height={1} />
      {showPrefixHint && (
        <>
          <Box height={1}>
            <Text fg={colors.textDim}>{t("Type these in the command bar (")}<Span fg={colors.text}><Strong>{"Ctrl+P"}</Strong></Span>{"):"}</Text>
          </Box>
          <Box height={1} />
        </>
      )}

      {commandPrefixes.map((shortcut) => (
        <Box key={shortcut.key} height={1} flexDirection="row">
          <Text fg={colors.text} attributes={TextAttributes.BOLD}>{shortcut.key.padEnd(COL)}</Text>
          <Text fg={colors.textDim}>{shortcut.desc}</Text>
        </Box>
      ))}

      {showTagline && (
        <>
          <Box height={gap} />
          <Box height={1}>
            <Text fg={colors.textDim}>{t("Everything is searchable, just type what you want.")}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

export function ReadyStep({
  brokerName,
  portfolioName,
  brokerSyncSummary,
  accountOutcome,
  isFinishing,
  error,
}: {
  brokerName: string | null;
  portfolioName: string;
  brokerSyncSummary: BrokerSyncSummary | null;
  accountOutcome: AccountOutcome | null;
  isFinishing: boolean;
  error: string | null;
}) {
  const positionsImported = brokerSyncSummary?.positionsImported ?? 0;
  const positionLabel = positionsImported === 1 ? "position" : "positions";
  const accountEmail = accountOutcome?.email ?? "";

  return (
    <Box flexDirection="column" paddingX={2}>
      <Box height={2} />
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{t("You're all set")}</Text>
      </Box>
      <Box height={2} />
      <Box height={1} flexDirection="row">
        <Text fg={colors.positive} attributes={TextAttributes.BOLD}>{"\u2713 "}</Text>
        <Text fg={colors.text}>{t("Theme configured")}</Text>
      </Box>
      <Box height={1} flexDirection="row">
        <Text fg={colors.positive} attributes={TextAttributes.BOLD}>{"\u2713 "}</Text>
        <Text fg={colors.text}>
          {brokerName
            ? tf("{broker} connected. Imported {count} {label}", { broker: brokerName, count: positionsImported, label: t(positionLabel) })
            : tf('Portfolio "{name}" created', { name: portfolioName })}
        </Text>
      </Box>
      <Box height={1} flexDirection="row">
        <Text fg={colors.positive} attributes={TextAttributes.BOLD}>{"\u2713 "}</Text>
        <Text fg={colors.text}>{t("Plugins enabled")}</Text>
      </Box>
      {accountOutcome && (
        <Box height={1} flexDirection="row">
          <Text fg={colors.positive} attributes={TextAttributes.BOLD}>{"\u2713 "}</Text>
          <Text fg={colors.text}>
            {!accountEmail
              ? t("Signed in to Gloom Cloud")
              : accountOutcome.mode === "signup"
                ? tf("Account created for {email}", { email: accountEmail })
                : tf("Signed in as {email}", { email: accountEmail })}
          </Text>
        </Box>
      )}
      <Box height={1} />
      {accountOutcome?.mode === "signup" ? (
        <Box height={2}>
          <Text fg={colors.text}>
            {t("Check your inbox to verify your email. Then start your free 7-day Pro trial anytime \u2014 type UPGRADE.")}
          </Text>
        </Box>
      ) : accountOutcome ? null : (
        <Box height={1}>
          <Text fg={colors.textMuted}>{t("Create an account anytime: Ctrl+P \u2192 Sign Up.")}</Text>
        </Box>
      )}
      <Box height={1} />
      {brokerName ? (
        <Box height={1}>
          <Text fg={isFinishing ? colors.text : colors.textDim}>
            {isFinishing
              ? t("Launching Gloomberb...")
              : positionsImported > 0
                ? t("Your broker portfolio is ready and will open directly after launch.")
                : t("Broker sync finished. If you expected holdings, check the selected account or connection mode.")}
          </Text>
        </Box>
      ) : (
        <Box height={1}>
          <Text fg={colors.textDim}>{t("Search for broker names in the command bar to connect.")}</Text>
        </Box>
      )}
      {error && (
        <>
          <Box height={1} />
          <Box height={2}>
            <Text fg={colors.negative}>{error}</Text>
          </Box>
        </>
      )}
      <Box height={2} />
      <Box height={1} flexDirection="row">
        <Text fg={colors.textDim}>{t("Data stored in ")}</Text>
        <Text fg={colors.text}>{"~/gloomberb/"}</Text>
      </Box>
      <Box height={1} />
    </Box>
  );
}
