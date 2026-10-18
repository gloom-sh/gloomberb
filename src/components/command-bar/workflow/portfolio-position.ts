import type { CommandBarFieldValue, CommandBarWorkflowField } from "./types";
import type { AppConfig } from "../../../types/config";
import type { TickerRecord } from "../../../types/ticker";
import { tf } from "../../../i18n";
import {
  getManualPortfolioPositionPrefill,
  isManualPortfolio,
  resolveManualPositionCurrency,
  type ManualPortfolioPositionPrefill,
} from "../../../portfolio/mutations";

export interface SetPortfolioPositionWorkflowState {
  fields: CommandBarWorkflowField[];
  values: Record<string, CommandBarFieldValue>;
  pendingLabel: string;
}

interface ManualPortfolioPositionWorkflowOptions {
  preferredPortfolioId?: string | null;
  ticker: TickerRecord | null;
  pendingLabel: string;
  positionOptional?: boolean;
  defaultAvgCost?: number | null;
  hidePortfolioFieldWhenSingleOption?: boolean;
}

/** Several lots become one position on save: say so, and what the fields hold. */
function lotsReplacementHint(prefill: ManualPortfolioPositionPrefill, portfolioName: string): string | undefined {
  if (prefill.lotCount < 2) return undefined;
  const params = { count: prefill.lotCount, portfolio: portfolioName };
  if (prefill.position) {
    return tf("Totals of your {count} lots in \"{portfolio}\". Saving replaces them with one position and clears their acquisition dates.", params);
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
      label: "Shares",
      type: "number",
      placeholder: "10",
      ...(lotsHint ? { description: lotsHint } : {}),
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
      placeholder: options.ticker
        ? resolveManualPositionCurrency(undefined, options.ticker, preferredPortfolio, config.baseCurrency)
        : undefined,
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
    currency: preferredPosition?.currency ?? "",
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
  },
): SetPortfolioPositionWorkflowState | null {
  return buildManualPortfolioPositionWorkflow(config, {
    preferredPortfolioId: options.activeCollectionId,
    ticker: options.activeTicker,
    pendingLabel: "Saving position…",
  });
}

export function buildAddToPortfolioWorkflow(
  config: AppConfig,
  options: {
    preferredPortfolioId?: string | null;
    ticker: TickerRecord | null;
    defaultAvgCost?: number | null;
  },
): SetPortfolioPositionWorkflowState | null {
  return buildManualPortfolioPositionWorkflow(config, {
    preferredPortfolioId: options.preferredPortfolioId,
    ticker: options.ticker,
    pendingLabel: "Adding to portfolio…",
    positionOptional: true,
    defaultAvgCost: options.defaultAvgCost,
    hidePortfolioFieldWhenSingleOption: true,
  });
}
