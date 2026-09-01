import {
  ConnectionState,
  EventName,
  type IBApiNext,
} from "@stoqey/ib";
import type { IbkrSnapshot } from "../../ibkr/gateway-types";
import {
  getIbErrorCode,
  getIbErrorMessage,
  isIbInformationalWarning,
  isMarketDataPermissionError,
} from "./market-data";

interface IbkrConnectionEventBinding {
  api: IBApiNext;
  getRawApi: () => any;
  getSnapshot: () => IbkrSnapshot;
  getConnectionNote: () => string | undefined;
  isAutoMarketData: () => boolean;
  setCachedAccountIds: (accountIds: string[]) => void;
  updateSnapshot: (snapshot: IbkrSnapshot) => void;
}

export function bindIbkrConnectionEvents({
  api,
  getRawApi,
  getSnapshot,
  getConnectionNote,
  isAutoMarketData,
  setCachedAccountIds,
  updateSnapshot,
}: IbkrConnectionEventBinding): void {
  api.connectionState.subscribe((state) => {
    const snapshot = getSnapshot();
    if (state === ConnectionState.Connected) {
      updateSnapshot({
        ...snapshot,
        status: {
          state: "connected",
          updatedAt: Date.now(),
          mode: "gateway",
          message: getConnectionNote(),
        },
      });
    } else if (state === ConnectionState.Connecting) {
      updateSnapshot({
        ...snapshot,
        status: {
          state: "connecting",
          updatedAt: Date.now(),
          mode: "gateway",
          message: getConnectionNote(),
        },
      });
    } else {
      updateSnapshot({
        ...snapshot,
        status: { state: "disconnected", updatedAt: Date.now(), mode: "gateway" },
      });
    }
  });

  const rawApi = getRawApi();
  rawApi.on(EventName.managedAccounts, (accountsList: string) => {
    setCachedAccountIds(accountsList.split(",").map((entry) => entry.trim()).filter(Boolean));
  });

  api.error.subscribe((err) => {
    const code = getIbErrorCode(err);
    const message = getIbErrorMessage(err);
    const snapshot = getSnapshot();
    if (isMarketDataPermissionError(code, message)) {
      updateSnapshot({
        ...snapshot,
        status: {
          state: "connected",
          updatedAt: Date.now(),
          mode: "gateway",
          message: isAutoMarketData()
            ? "Live API market data unavailable; delayed quotes will be used when IBKR allows them."
            : message,
        },
        lastError: message,
      });
      return;
    }
    if (isIbInformationalWarning(code, message)) {
      updateSnapshot({
        ...snapshot,
        status: {
          ...snapshot.status,
          updatedAt: Date.now(),
          mode: "gateway",
          message,
        },
      });
      return;
    }

    const keepConnectionState = snapshot.status.state === "connected" || snapshot.status.state === "connecting";
    updateSnapshot({
      ...snapshot,
      status: keepConnectionState
        ? {
          ...snapshot.status,
          updatedAt: Date.now(),
          mode: "gateway",
          message,
        }
        : { state: "error", updatedAt: Date.now(), mode: "gateway", message },
      lastError: message,
    });
  });
}
