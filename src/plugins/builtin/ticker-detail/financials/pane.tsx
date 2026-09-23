import { PaneFooterScope } from "../../../../components";
import type { PaneProps, TickerResearchTabProps } from "../../../../types/plugin";
import { usePaneTicker } from "../../../../state/app/context";
import { ResolvedFinancialsTab } from "./tab";

export function FinancialsResearchTab({ width, focused }: TickerResearchTabProps) {
  const { financials } = usePaneTicker();
  return (
    <ResolvedFinancialsTab
      width={width}
      focused={focused}
      financials={financials}
      allowArrowSubTabNavigation={false}
    />
  );
}

export function FinancialAnalysisPane({ width, focused }: PaneProps) {
  const { financials } = usePaneTicker();
  return (
    <PaneFooterScope active>
      <ResolvedFinancialsTab
        width={width}
        focused={focused}
        financials={financials}
      />
    </PaneFooterScope>
  );
}
