import { useEffect, useState } from "react";
import { priceColor } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { useAppActive } from "../../state/app/activity";
import { useAppSelector } from "../../state/app/context";
import { selectBaseCurrency } from "../../state/selectors-ui";
import { getSharedMarketDataCoordinator } from "../../market-data/coordinator";
import { t } from "../../i18n";
import { useQuoteEntry, useResolvedEntryValue } from "../../market-data/hooks";
import { formatPercentRaw } from "../../utils/format";
import { formatMarketPrice } from "../../market-data/market/format";
import { getActiveQuoteDisplay, marketStateColor, marketStateCountdown, marketStateLabel } from "../../market-data/market/status";

const SPY_REFRESH_MS = 5 * 60_000; // 5 min

export interface MarketSummary {
  baseCurrency: string;
  marketColor: string;
  /** Market state with its countdown, when the state has one. */
  marketLabel: string;
  /** Market state alone, for status bars too narrow for the countdown. */
  marketLabelShort: string;
  spyColor: string;
  spyText: string;
}

export function useMarketSummary(): MarketSummary {
  const colors = useThemeColors();
  const appActive = useAppActive();
  const baseCurrency = useAppSelector(selectBaseCurrency);
  const spyQuoteEntry = useQuoteEntry("SPY", null);
  const spyQuote = useResolvedEntryValue(spyQuoteEntry);
  const mktState = spyQuote?.marketState;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!appActive || (mktState !== "PRE" && mktState !== "REGULAR")) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [appActive, mktState]);

  useEffect(() => {
    if (!appActive) return;
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) return;
    const fetchSpy = async () => {
      await coordinator.loadQuote({ symbol: "SPY" }).catch(() => {});
    };
    fetchSpy();
    const id = setInterval(fetchSpy, SPY_REFRESH_MS);
    return () => { clearInterval(id); };
  }, [appActive]);

  const activeSpyQuote = getActiveQuoteDisplay(spyQuote);
  const spyColor = activeSpyQuote ? priceColor(activeSpyQuote.change, colors) : colors.textDim;
  const spyText = activeSpyQuote
    ? `SPY ${formatMarketPrice(activeSpyQuote.price, { assetCategory: "ETF" })} ${formatPercentRaw(activeSpyQuote.changePercent)}`
    : "SPY —";

  const mktCountdown = mktState ? marketStateCountdown(mktState, now) : null;
  const marketLabelShort = mktState ? t(marketStateLabel(mktState)) : "";
  const marketLabel = marketLabelShort && mktCountdown
    ? `${marketLabelShort} · ${mktCountdown}`
    : marketLabelShort;

  return {
    baseCurrency,
    marketColor: mktState ? marketStateColor(mktState, colors) : colors.textDim,
    marketLabel,
    marketLabelShort,
    spyColor,
    spyText,
  };
}
