import { useReducer, type ReactElement } from "react";
import {
  AppContext,
  appReducer,
  createInitialState,
  PaneInstanceProvider,
} from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { cloneLayout, createDefaultConfig, type AppConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import { PluginRenderProvider } from "../../runtime";
import { positionSizerModule } from "./index";

export const TEST_PANE_ID = "kelly-sizer:test";

const KellySizerPane = positionSizerModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => ReactElement;

export function createSizerConfig(symbol = "AAPL"): AppConfig {
  const baseConfig = createDefaultConfig("/tmp/gloomberb-kelly-sizer");
  const layout: AppConfig["layout"] = {
    dockRoot: { kind: "pane", instanceId: TEST_PANE_ID },
    instances: [{
      instanceId: TEST_PANE_ID,
      paneId: "kelly-sizer",
      binding: { kind: "none" },
      params: { symbol },
    }],
    floating: [],
    detached: [],
  };

  return {
    ...baseConfig,
    brokerInstances: [{
      id: "ibkr-flex",
      brokerType: "ibkr",
      label: "IBKR Flex",
      config: {},
    }],
    portfolios: [{
      id: "main",
      name: "Main Portfolio",
      currency: "USD",
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-flex",
      brokerAccountId: "DU12345",
    }],
    layout,
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
  };
}

export function createTicker({
  symbol = "AAPL",
  currency = "USD",
  positions,
}: {
  symbol?: string;
  currency?: string;
  positions?: TickerRecord["metadata"]["positions"];
} = {}): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency,
      name: symbol === "AAPL" ? "Apple" : symbol,
      sector: "Technology",
      portfolios: ["main"],
      watchlists: [],
      positions: positions ?? [{
        portfolio: "main",
        shares: 20,
        avgCost: 180,
        currency,
        broker: "ibkr",
        brokerInstanceId: "ibkr-flex",
        brokerAccountId: "DU12345",
        marketValue: 4_000,
        unrealizedPnl: 400,
      }],
      custom: {},
      tags: [],
    },
  };
}

export function createFinancials({
  symbol = "AAPL",
  price = 200,
  currency = "USD",
}: {
  symbol?: string;
  price?: number;
  currency?: string;
} = {}): TickerFinancials {
  return {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
    quote: {
      symbol,
      price,
      currency,
      change: price * 0.01,
      changePercent: 1,
      previousClose: price * 0.99,
      lastUpdated: Date.now(),
    },
  };
}

function createBrokerAccount(): BrokerAccount {
  return {
    accountId: "DU12345",
    name: "DU12345",
    currency: "USD",
    source: "flex",
    updatedAt: Date.now(),
    totalCashValue: 20_000,
    netLiquidation: 100_000,
    dailyPnl: 0,
    unrealizedPnl: 400,
    cashBalances: [],
  };
}

export function KellySizerHarness({
  config = createSizerConfig(),
  ticker = createTicker(),
  financials = createFinancials({ symbol: ticker.metadata.ticker, currency: ticker.metadata.currency }),
  paneState,
}: {
  config?: AppConfig;
  ticker?: TickerRecord;
  financials?: TickerFinancials;
  paneState?: Record<string, unknown>;
}) {
  const initialState = createInitialState(config);
  initialState.focusedPaneId = TEST_PANE_ID;
  if (paneState) initialState.paneState[TEST_PANE_ID] = paneState;
  initialState.tickers = new Map([[ticker.metadata.ticker, ticker]]);
  initialState.financials = new Map([[ticker.metadata.ticker, financials]]);
  initialState.brokerAccounts = { "ibkr-flex": [createBrokerAccount()] };

  const [state, dispatch] = useReducer(appReducer, initialState);

  return (
    <AppContext value={{ state, dispatch }}>
      <PaneInstanceProvider paneId={TEST_PANE_ID}>
        <PluginRenderProvider pluginId="portfolio" runtime={createTestPluginRuntime()}>
          <KellySizerPane
            paneId={TEST_PANE_ID}
            paneType="kelly-sizer"
            focused
            width={100}
            height={30}
          />
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}
