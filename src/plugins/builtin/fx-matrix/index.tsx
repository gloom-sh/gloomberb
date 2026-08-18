import { Box, ScrollBox, Text } from "../../../ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { TextAttributes } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { usePaneFooter } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { colors, blendHex } from "../../../theme/colors";
import { useAssetData } from "../../runtime";
import { useUpdatedAgo } from "../shared/auto-refresh";
import { MAJOR_CURRENCIES, formatRate, type MajorCurrency } from "./pairs";

// Cross rates are a live board, so this pane keeps its own fast cadence rather
// than following the global refresh interval.
const REFRESH_INTERVAL_MS = 60_000;

function FxMatrixPane({ focused, width, height }: PaneProps) {
  const dataProvider = useAssetData();
  const [rates, setRates] = useState<Map<MajorCurrency, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
  const fetchGenRef = useRef(0);

  const fetchRates = useCallback(async () => {
    if (!dataProvider) return;

    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;

    try {
      const results = await Promise.allSettled(
        MAJOR_CURRENCIES.map(async (currency) => {
          if (currency === "USD") return { currency, rate: 1 };
          const rate = await dataProvider.getExchangeRate(currency);
          return { currency, rate };
        }),
      );

      if (fetchGenRef.current !== gen) return;

      const newRates = new Map<MajorCurrency, number>();
      for (const result of results) {
        if (result.status === "fulfilled") {
          newRates.set(result.value.currency as MajorCurrency, result.value.rate);
        }
      }

      setRates(newRates);
      setLastRefreshed(Date.now());
    } finally {
      if (fetchGenRef.current === gen) setLoading(false);
    }
  }, [dataProvider]);

  useEffect(() => {
    fetchRates();
    const interval = setInterval(fetchRates, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchRates]);

  useShortcut((event) => {
    if (!focused) return;
    if (event.name === "r") {
      fetchRates();
    }
  });

  const headerBg = blendHex(colors.bg, colors.border, 0.3);

  function crossRate(row: MajorCurrency, col: MajorCurrency): number | null {
    if (row === col) return 1;
    const rowUsd = rates.get(row);
    const colUsd = rates.get(col);
    if (rowUsd == null || colUsd == null) return null;
    return rowUsd / colUsd;
  }

  const updatedAgo = useUpdatedAgo(lastRefreshed);
  const ageText = updatedAgo ? `updated ${updatedAgo}` : loading ? "loading…" : "";

  usePaneFooter("fx-matrix", () => ({
    info: ageText ? [{ id: "updated", parts: [{ text: ageText, tone: loading ? "muted" : "value" }] }] : [],
    hints: [{ id: "refresh", key: "r", label: "efresh", onPress: fetchRates }],
  }), [ageText, fetchRates, loading]);

  // Row header: just the 3-letter code, no emoji (keeps width predictable)
  // Rates use flexGrow so they fill available space dynamically

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Column header row */}
      <Box flexDirection="row" paddingX={1} height={1} backgroundColor={headerBg}>
        <Box width={5} flexShrink={0} />
        {MAJOR_CURRENCIES.map((col) => (
          <Box key={col} flexGrow={1} justifyContent="flex-end" paddingRight={1}>
            <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>{col}</Text>
          </Box>
        ))}
      </Box>

      {/* Matrix rows */}
      <ScrollBox flexGrow={1} scrollY focusable={false}>
        <Box flexDirection="column">
          {loading && rates.size === 0 ? (
            <Box paddingX={1} paddingY={1}>
              <Text fg={colors.textMuted}>Fetching rates…</Text>
            </Box>
          ) : (
            MAJOR_CURRENCIES.map((row) => (
              <Box key={row} flexDirection="row" paddingX={1}>
                <Box width={5} flexShrink={0}>
                  <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{row}</Text>
                </Box>
                {MAJOR_CURRENCIES.map((col) => {
                  const rate = crossRate(row, col);
                  const isDiag = row === col;
                  return (
                    <Box key={col} flexGrow={1} justifyContent="flex-end" paddingRight={1}>
                      {rate == null ? (
                        <Text fg={colors.textDim}>—</Text>
                      ) : (
                        <Text fg={isDiag ? colors.textDim : colors.text}>
                          {formatRate(rate, col)}
                        </Text>
                      )}
                    </Box>
                  );
                })}
              </Box>
            ))
          )}
        </Box>
      </ScrollBox>
    </Box>
  );
}

export const fxMatrixModule: PluginModule = {
  panes: [
    {
      id: "fx-matrix",
      name: "FX Cross Rates",
      icon: "F",
      component: FxMatrixPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 105, height: 14 },
    },
  ],

  paneTemplates: [
    {
      id: "fx-matrix-pane",
      paneId: "fx-matrix",
      label: "FX Cross Rates",
      description: "Currency cross-rate matrix for major FX pairs.",
      keywords: ["fx", "forex", "currency", "exchange", "rates", "cross", "matrix"],
      shortcut: { prefix: "FXC" },
    },
  ],
};
