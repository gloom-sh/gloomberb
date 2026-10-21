import type { CommandBarFieldValue, CommandBarWorkflowField } from "./types";
import type { AppConfig } from "../../../types/config";
import type { TickerRecord } from "../../../types/ticker";
import { t, tf } from "../../../i18n";
import { getManualPortfolioPositionPrefill, type ManualPortfolioPositionPrefill } from "../../../portfolio/manual-lots";
import { isManualPortfolio, positionQuantityLabel, resolveManualPositionCurrency } from "../../../portfolio/mutations";
import { futuresLotCurrency, isFuturesTicker } from "../../../portfolio/futures-positions";
import { sameCurrency } from "../../../portfolio/position-metrics";
import { resolvePortfolioTotalsCurrency } from "../../../portfolio/totals-currency";
import type { TickerPosition } from "../../../types/ticker";
import { DATE_FIELD_EXAMPLES } from "../../../utils/calendar-date";
import { US_CENTS } from "../../../utils/currency-units";

export interface SetPortfolioPositionWorkflowState {
  fields: CommandBarWorkflowField[];
  values: Record<string, CommandBarFieldValue>;
  pendingLabel: string;
}

interface ManualPortfolioPositionWorkflowOptions {
  preferredPortfolioId?: string | null;
  ticker: TickerRecord | null;
  /** The ticker's quote currency, when one is loaded: a corn future quotes in US cents (USX). */
  quoteCurrency?: string | null;
  pendingLabel: string;
  positionOptional?: boolean;
  defaultAvgCost?: number | null;
  hidePortfolioFieldWhenSingleOption?: boolean;
}

/**
 * What the Purchase Date and Cost FX fields start from for a holding: its
 * date (several lots, their earliest) and the rate its cost was bought at
 * into the portfolio's currency (several, weighted by cost). Saving them
 * unchanged keeps what the lots have; a rate into another currency is kept
 * without being shown.
 */
export function positionCostTermsPrefill(position: TickerPosition | null | undefined, portfolioCurrency: string): { dateAcquired: string; costFx: string } {
  const rate = position?.costFxRate;
  const shown = typeof rate === "number" && Number.isFinite(rate) && rate > 0 && position?.costFxCurrency?.trim().toUpperCase() === portfolioCurrency;
  // A cross rate carries float noise (0.012625500000000001): shown to ten digits, kept exact when left as it opened.
  return { dateAcquired: position?.dateAcquired ?? "", costFx: shown ? String(Number(rate.toPrecision(10))) : "" };
}

/** Several lots become one position on save: say so, and what the fields hold. */
function lotsReplacementHint(prefill: ManualPortfolioPositionPrefill, portfolioName: string): string | undefined {
  if (prefill.lotCount < 2) return undefined;
  const params = { count: prefill.lotCount, portfolio: portfolioName };
  if (prefill.position && prefill.costFxConflict) {
    return tf("Totals of your {count} lots in \"{portfolio}\", bought at FX rates one position cannot keep: give its Cost FX or Purchase Date. Saving replaces them with one position.", params);
  }
  if (prefill.position) {
    return tf("Totals of your {count} lots in \"{portfolio}\". Saving replaces them with one position, dated by the earliest.", params);
  }
  return prefill.currencies
    ? tf("{count} lots in \"{portfolio}\" are in different currencies ({currencies}), so none is filled in. Saving replaces them with one position.", {
      ...params,
      currencies: prefill.currencies.map((currency) => currency || "none").join(", "),
    })
    : tf("{count} lots in \"{portfolio}\" cannot be totalled, so none is filled in. Saving replaces them with one position.", params);
}

function buildManualPortfolioPositionWorkflow(
  config: AppConfig,
  options: ManualPortfolioPositionWorkflowOptions,
): SetPortfolioPositionWorkflowState | null {
  const manualPortfolios = config.portfolios.filter(isManualPortfolio);
  if (manualPortfolios.length === 0) return null;

  const preferredPortfolio = manualPortfolios.find((portfolio) => portfolio.id === options.preferredPortfolioId) ?? manualPortfolios[0]!;
  const prefill = options.ticker ? getManualPortfolioPositionPrefill(options.ticker, preferredPortfolio.id) : null;
  const preferredPosition = prefill?.position ?? null;
  // Lots with nothing to total start blank, not at the default cost.
  const hasUntotalledLots = (prefill?.lotCount ?? 0) > 1 && !preferredPosition;
  const lotsHint = prefill ? lotsReplacementHint(prefill, preferredPortfolio.name) : undefined;
  const showPortfolioField = !options.hidePortfolioFieldWhenSingleOption || manualPortfolios.length > 1;
  // A future's cost is typed as it is quoted, which for corn is cents: what a blank currency then saves.
  const contractCurrency = options.ticker && isFuturesTicker(options.ticker)
    && options.quoteCurrency?.trim().toUpperCase() === US_CENTS ? US_CENTS : undefined;
  // What a blank currency saves, and the currency the portfolio values it in: the rate's units.
  const blankCurrency = options.ticker
    ? resolveManualPositionCurrency(undefined, options.ticker, preferredPortfolio, config.baseCurrency, contractCurrency)
    : undefined;
  const portfolioCurrency = resolvePortfolioTotalsCurrency(preferredPortfolio, config.baseCurrency);
  const heldCurrency = (preferredPosition ? futuresLotCurrency(preferredPosition, contractCurrency) : undefined) ?? blankCurrency;
  const costTerms = positionCostTermsPrefill(preferredPosition, portfolioCurrency);

  const fields: CommandBarWorkflowField[] = [
    ...(showPortfolioField ? [{
      id: "portfolioId",
      label: "Portfolio",
      type: "select" as const,
      options: manualPortfolios.map((portfolio) => ({
        label: portfolio.name,
        value: portfolio.id,
        description: portfolio.currency,
      })),
      required: true,
    }] : []),
    {
      id: "ticker",
      label: "Ticker",
      type: "text",
      placeholder: "AAPL",
      required: true,
    },
    {
      id: "shares",
      // A future is held in contracts.
      label: positionQuantityLabel(options.ticker),
      type: "number",
      placeholder: "10",
      description: lotsHint ?? t("Negative for a short."),
      required: !options.positionOptional,
    },
    {
      id: "avgCost",
      label: "Avg Cost",
      type: "number",
      placeholder: "180",
      required: !options.positionOptional,
    },
    {
      id: "currency",
      label: "Currency",
      type: "text",
      // What a blank field saves: the ticker's own currency before the
      // portfolio's. Without a ticker yet there is nothing true to show.
      placeholder: blankCurrency,
      required: false,
    },
    {
      id: "dateAcquired",
      label: "Purchase Date",
      type: "text",
      placeholder: DATE_FIELD_EXAMPLES,
      required: false,
    },
    {
      id: "costFx",
      label: "Cost FX",
      type: "number",
      // What a blank field saves, as `position set` without --cost-fx does.
      placeholder: t("The purchase date's close, else today's rate"),
      // The rate's units, in context: the portfolio's currency per unit of the holding's.
      description: heldCurrency && sameCurrency(heldCurrency, portfolioCurrency)
        ? t("Only for a holding in another currency than the portfolio's.")
        : heldCurrency
          ? tf("{portfolio} per {holding} when bought.", { portfolio: portfolioCurrency, holding: heldCurrency })
          : tf("{portfolio} per unit of the holding's currency when bought.", { portfolio: portfolioCurrency }),
      required: false,
    },
  ];

  const values: Record<string, CommandBarFieldValue> = {
    portfolioId: preferredPortfolio.id,
    ticker: options.ticker?.metadata.ticker ?? "",
    shares: preferredPosition ? String(preferredPosition.shares) : "",
    avgCost: preferredPosition
      ? Number.isFinite(preferredPosition.avgCost) ? String(preferredPosition.avgCost) : ""
      : Number.isFinite(options.defaultAvgCost) && !hasUntotalledLots
        ? String(options.defaultAvgCost)
        : "",
    // A corn lot saved before contract sizes, in dollars, is read in cents: saving the form unchanged keeps it so.
    currency: (preferredPosition ? futuresLotCurrency(preferredPosition, contractCurrency) : undefined) ?? "",
    dateAcquired: costTerms.dateAcquired,
    costFx: costTerms.costFx,
  };

  return {
    fields,
    values,
    pendingLabel: options.pendingLabel,
  };
}

export function buildSetPortfolioPositionWorkflow(
  config: AppConfig,
  options: {
    activeCollectionId: string | null;
    activeTicker: TickerRecord | null;
    activeQuoteCurrency?: string | null;
  },
): SetPortfolioPositionWorkflowState | null {
  return buildManualPortfolioPositionWorkflow(config, {
    preferredPortfolioId: options.activeCollectionId,
    ticker: options.activeTicker,
    quoteCurrency: options.activeQuoteCurrency,
    pendingLabel: "Saving position…",
  });
}

export function buildAddToPortfolioWorkflow(
  config: AppConfig,
  options: {
    preferredPortfolioId?: string | null;
    ticker: TickerRecord | null;
    quoteCurrency?: string | null;
    defaultAvgCost?: number | null;
  },
): SetPortfolioPositionWorkflowState | null {
  return buildManualPortfolioPositionWorkflow(config, {
    preferredPortfolioId: options.preferredPortfolioId,
    ticker: options.ticker,
    quoteCurrency: options.quoteCurrency,
    pendingLabel: "Adding to portfolio…",
    positionOptional: true,
    defaultAvgCost: options.defaultAvgCost,
    hidePortfolioFieldWhenSingleOption: true,
  });
}
