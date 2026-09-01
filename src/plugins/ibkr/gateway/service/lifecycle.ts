import { ConnectionState, IBApiNext, type MarketDataType } from "@stoqey/ib";
import { firstValueFrom, filter, take, timeout } from "rxjs";
import { debugLog } from "../../../../utils/debug-log";
import type { IbkrClientLockManager } from "../client-lock";
import {
  buildConnectionNote,
  resolveGatewayConnection,
} from "../connection";
import {
  getIbErrorCode,
  getIbErrorMessage,
  isClientIdInUseError,
  marketDataTypeFromConfig,
} from "../market-data";
import type { IbkrGatewayConfig, IbkrSnapshot, ResolvedIbkrGatewayConnection } from "../types";

const gatewayLifecycleLog = debugLog.createLogger("ibkr-gateway");

export type ResolvedGatewayListener = (
  instanceId: string | undefined,
  connection: ResolvedIbkrGatewayConnection,
) => void | Promise<void>;

export interface ConnectIbkrGatewayInternalContext {
  instanceId: string | undefined;
  bindConnectionEvents: (api: IBApiNext) => void;
  disconnect: () => Promise<void>;
  getApi: () => IBApiNext | null;
  getConfigKey: () => string | null;
  getRequestedClientId: () => number | undefined;
  getSnapshot: () => IbkrSnapshot;
  loadInitialSnapshot: () => Promise<void>;
  setActiveMarketDataType: (marketDataType: MarketDataType) => void;
  setApi: (api: IBApiNext | null) => void;
  setAutoMarketData: (auto: boolean) => void;
  setConfigKey: (configKey: string | null) => void;
  setConnectionNote: (connectionNote: string | undefined) => void;
  updateSnapshot: (snapshot: IbkrSnapshot) => void;
}

export async function connectIbkrGatewayInternal(
  context: ConnectIbkrGatewayInternalContext,
  config: IbkrGatewayConfig,
  configKey: string,
  connectionNote?: string,
): Promise<void> {
  if (context.getApi() && context.getConfigKey() !== configKey) {
    await context.disconnect();
  }

  context.setConnectionNote(connectionNote);
  context.updateSnapshot({
    ...context.getSnapshot(),
    status: {
      state: "connecting",
      updatedAt: Date.now(),
      mode: "gateway",
      message: connectionNote,
    },
    lastError: undefined,
  });

  let api = context.getApi();
  if (!api) {
    api = new IBApiNext({
      host: config.host,
      port: config.port,
      reconnectInterval: 2_000,
    });
    context.setApi(api);
    context.bindConnectionEvents(api);
  }

  let unsubscribeConflict = () => {};
  const conflictPromise = new Promise<never>((_, reject) => {
    const subscription = api!.error.subscribe((err) => {
      const code = getIbErrorCode(err);
      const message = getIbErrorMessage(err);
      if (!isClientIdInUseError(code, message)) return;
      subscription.unsubscribe();
      reject(new Error(message || `IBKR client ID ${config.clientId} is already in use.`));
    });
    unsubscribeConflict = () => subscription.unsubscribe();
  });

  api.connect(config.clientId);
  try {
    await Promise.race([
      firstValueFrom(api.connectionState.pipe(
        filter((state) => state === ConnectionState.Connected),
        take(1),
        timeout(10_000),
      )),
      conflictPromise,
    ]);
  } finally {
    unsubscribeConflict();
  }

  gatewayLifecycleLog.info("Connected to IBKR gateway", {
    instanceId: context.instanceId,
    requestedClientId: context.getRequestedClientId() ?? config.clientId,
    actualClientId: config.clientId,
    host: config.host,
    port: config.port,
  });

  context.setAutoMarketData((config.marketDataType ?? "auto") === "auto");
  const activeMarketDataType = marketDataTypeFromConfig(config);
  context.setActiveMarketDataType(activeMarketDataType);
  api.setMarketDataType(activeMarketDataType);
  context.setConfigKey(configKey);
  await context.loadInitialSnapshot();
  context.updateSnapshot({
    ...context.getSnapshot(),
    status: {
      state: "connected",
      updatedAt: Date.now(),
      mode: "gateway",
      message: connectionNote,
    },
  });
}

export async function connectWithClientFallback({
  config,
  configKey,
  clientLocks,
  snapshot,
  updateSnapshot,
  connectInternal,
  disconnect,
  onResolved,
}: {
  config: IbkrGatewayConfig;
  configKey: string;
  clientLocks: IbkrClientLockManager;
  snapshot: IbkrSnapshot;
  updateSnapshot: (snapshot: IbkrSnapshot) => void;
  connectInternal: (config: IbkrGatewayConfig, configKey: string, connectionNote?: string) => Promise<void>;
  disconnect: () => Promise<void>;
  onResolved: (connection: ResolvedIbkrGatewayConnection) => void;
}): Promise<void> {
  let resolvedConfig: ResolvedIbkrGatewayConnection;
  try {
    resolvedConfig = await resolveGatewayConnection(config);
  } catch (error: any) {
    const message = error?.message || String(error || "");
    updateSnapshot({
      ...snapshot,
      status: {
        state: "error",
        updatedAt: Date.now(),
        mode: "gateway",
        message,
      },
      lastError: message,
    });
    throw error;
  }

  const candidates = clientLocks.getClientIdCandidates(resolvedConfig.requestedClientId);
  let lastConflict: Error | null = null;

  for (const clientId of candidates) {
    const claimed = await clientLocks.tryClaim(resolvedConfig, clientId, resolvedConfig.requestedClientId);
    if (!claimed) continue;

    try {
      await connectInternal(
        { ...config, host: resolvedConfig.host, port: resolvedConfig.port, clientId },
        configKey,
        buildConnectionNote(resolvedConfig.requestedClientId, clientId, resolvedConfig.requestedPort, resolvedConfig.port),
      );
      onResolved({ ...resolvedConfig, clientId });
      return;
    } catch (error: any) {
      const code = getIbErrorCode(error);
      const message = getIbErrorMessage(error) || error?.message || String(error || "");
      await disconnect();
      if (!isClientIdInUseError(code, message)) {
        throw error;
      }
      lastConflict = new Error(message || `IBKR client ID ${clientId} is already in use.`);
    }
  }

  throw lastConflict ?? new Error(
    `No IBKR client IDs are available near ${resolvedConfig.requestedClientId}. Close other sessions or choose a different client ID.`,
  );
}
