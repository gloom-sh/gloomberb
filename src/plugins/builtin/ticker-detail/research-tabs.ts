import type { TickerFinancials } from "../../../types/financials";
import type { TickerResearchTabDef } from "../../../types/plugin";
import { FinancialsResearchTab } from "./financials/pane";
import { OverviewResearchTab } from "./overview/pane";

function hasStatementFinancials(financials: TickerFinancials | null | undefined): boolean {
  return (financials?.annualStatements.length ?? 0) > 0 || (financials?.quarterlyStatements.length ?? 0) > 0;
}

/**
 * Tabs this module owns. They are registered through `setup()` like any other
 * contribution, and the pane also falls back to them in a host that has no
 * plugin registry bound, where an unresolved registry would otherwise leave the
 * body completely empty. Every shipping host binds one, so the fallback is a
 * backstop rather than a code path anything relies on.
 */
export const TICKER_RESEARCH_BUILTIN_TABS: TickerResearchTabDef[] = [
  {
    id: "overview",
    name: "Overview",
    order: 10,
    component: OverviewResearchTab,
    isVisible: ({ ticker }) => !!ticker,
  },
  {
    id: "financials",
    name: "Financials",
    order: 20,
    component: FinancialsResearchTab,
    isVisible: ({ financials }) => hasStatementFinancials(financials),
  },
];
