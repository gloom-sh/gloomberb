import { PortfolioRiskPane } from "./risk-pane";
import { portfolioRiskHeadless } from "./risk-headless";
import { portfolioRiskCache } from "./risk-client";
import type { PluginModule } from "../plugin-module";
import { resolvePortfolioId, resolveTemplatePortfolioId } from "./portfolio-selection";

export const portfolioAnalyticsModule: PluginModule = {
  panes: [
    {
      id: "analytics",
      name: "Portfolio Analytics",
      icon: "R",
      component: PortfolioRiskPane,
      headless: portfolioRiskHeadless,
      tableExport: true,
      settings: { fields: [
        { key: "riskEvidence", label: "Local evidence JSON", type: "text" },
        { key: "equityShift", label: "Index shift (%)", type: "text" },
        { key: "rateShift", label: "10Y shift (bp)", type: "text" },
        { key: "volShift", label: "VIX shift (points)", type: "text" },
      ] },
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 80, height: 30 },
      portableShare: {
        private: { params: true, settings: true, state: true },
      },
    },
  ],

  setup(ctx) { portfolioRiskCache.attach(ctx.persistence); },
  dispose() { portfolioRiskCache.reset(); },
  paneTemplates: [{
    id: "analytics-pane",
    paneId: "analytics",
    label: "Portfolio Analytics",
    description: "Benchmark-relative risk, factor betas, sectors, stress shifts and account performance.",
    keywords: ["risk", "analytics", "sharpe", "beta", "sector", "allocation", "portfolio"],
    shortcut: { prefix: "PORT", aliases: ["MARS"], argKind: "text", argOptional: true, argPlaceholder: "portfolio-id" },
    headless: portfolioRiskHeadless,
    canCreate: (context) => context.config.portfolios.length > 0,
    createInstance: (context, options) => {
      const portfolioId = resolvePortfolioId(context.config.portfolios, options?.arg) ?? resolveTemplatePortfolioId(context.config.portfolios, context.activeCollectionId);
      return portfolioId ? { params: { portfolioId } } : null;
    },
  }],
};
