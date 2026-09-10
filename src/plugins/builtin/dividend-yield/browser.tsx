import { useCallback } from "react";
import { useAssetData } from "../../runtime";
import { createDividendYieldModule } from "./index";
import { DividendYieldPane } from "./pane";
import { createDividendYieldHeadless } from "./headless";
import { fetchProviderDividendData } from "./provider-client";

function BrowserDividendYieldPane(props: Parameters<typeof DividendYieldPane>[0]) {
  const provider = useAssetData();
  const loadData = useCallback((symbol: string, price: number | null, exchange = "", currency?: string) => {
    if (!provider) return Promise.reject(new Error("Dividend history source unavailable."));
    return fetchProviderDividendData(provider, symbol, price, exchange, currency);
  }, [provider]);
  return <DividendYieldPane {...props} loadData={loadData} />;
}

export const browserDividendYieldModule = createDividendYieldModule({
  component: BrowserDividendYieldPane,
  yahooConnection: false,
  headless: createDividendYieldHeadless({
    async loadData(symbol, context) {
      const instrument = await context.resolveInstrument?.(symbol);
      return fetchProviderDividendData(context.marketData, symbol, null, instrument?.exchange ?? "");
    },
  }),
});
