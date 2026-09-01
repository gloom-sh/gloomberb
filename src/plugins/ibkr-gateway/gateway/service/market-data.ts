import { MarketDataType } from "@stoqey/ib";
import { isMarketDataPermissionError } from "../market-data";
import type { IbkrSnapshot } from "../../../ibkr/gateway-types";

export async function withIbkrMarketDataFallback<T>({
  operation,
  autoMarketData,
  activeMarketDataType,
  setDelayedMarketData,
  getSnapshot,
  updateSnapshot,
}: {
  operation: () => Promise<T>;
  autoMarketData: boolean;
  activeMarketDataType: MarketDataType;
  setDelayedMarketData: () => void;
  getSnapshot: () => IbkrSnapshot;
  updateSnapshot: (snapshot: IbkrSnapshot) => void;
}): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    const message = error?.message || String(error || "");
    const isPermission = isMarketDataPermissionError(undefined, message);
    const isTimeout = message.includes("timed out");
    const isNoData = message.includes("No valid market data");
    if (
      !autoMarketData
      || activeMarketDataType === MarketDataType.DELAYED
      || !(isPermission || isTimeout || isNoData)
    ) {
      throw error;
    }

    setDelayedMarketData();
    updateSnapshot({
      ...getSnapshot(),
      status: {
        state: "connected",
        updatedAt: Date.now(),
        mode: "gateway",
        message: "Using delayed IBKR market data because live API market data is not enabled for this account.",
      },
      lastError: message,
    });
    return operation();
  }
}
