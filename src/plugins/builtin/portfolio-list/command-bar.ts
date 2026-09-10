import type { CommandBarFieldValue, CommandBarWorkflowField } from "../../../components/command-bar/workflow/types";
import type { AppConfig } from "../../../types/config";
import type { TickerRecord } from "../../../types/ticker";
import { getManualPortfolioPosition, isManualPortfolio } from "./mutations";

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

function buildManualPortfolioPositionWorkflow(
  config: AppConfig,
  options: ManualPortfolioPositionWorkflowOptions,
): SetPortfolioPositionWorkflowState | null {
  const manualPortfolios = config.portfolios.filter(isManualPortfolio);
  if (manualPortfolios.length === 0) return null;

  const preferredPortfolio = manualPortfolios.find((portfolio) => portfolio.id === options.preferredPortfolioId) ?? manualPortfolios[0]!;
  const preferredPosition = options.ticker
    ? getManualPortfolioPosition(options.ticker, preferredPortfolio.id)
    : null;
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
      description: "No automatic adjustments. Enter current quantity.",
      type: "number",
      placeholder: "10",
      required: !options.positionOptional,
    },
    {
      id: "avgCost",
      label: "Avg Cost",
      description: "Distributions are not tracked. Enter adjusted cost per share.",
      type: "number",
      placeholder: "180",
      required: !options.positionOptional,
    },
    {
      id: "currency",
      label: "Currency",
      type: "text",
      placeholder: preferredPortfolio.currency,
      required: false,
    },
  ];

  const values: Record<string, CommandBarFieldValue> = {
    portfolioId: preferredPortfolio.id,
    ticker: options.ticker?.metadata.ticker ?? "",
    shares: preferredPosition ? String(preferredPosition.shares) : "",
    avgCost: preferredPosition
      ? String(preferredPosition.avgCost)
      : Number.isFinite(options.defaultAvgCost)
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
