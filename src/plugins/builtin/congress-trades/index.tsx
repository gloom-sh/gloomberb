import { EmptyState, usePaneTicker } from "../../../components";
import type { TickerResearchTabProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { CongressTradesPane } from "./pane";

function CongressTickerTab(props: TickerResearchTabProps) {
  const { ticker } = usePaneTicker();
  const symbol = ticker?.metadata.ticker;
  if (!symbol) return <EmptyState title="Select a ticker." />;
  return <CongressTradesPane key={symbol} {...props} paneId="congress" paneType="congress-trades" tickerFilter={symbol} />;
}

export const congressResearchModule: PluginModule = {
  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "congress",
      name: "Congress",
      order: 38,
      component: CongressTickerTab,
      isVisible: ({ ticker }) => !!ticker,
    });
  },
};
