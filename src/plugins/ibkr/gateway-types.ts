import type { BrokerConnectionStatus } from "../../types/broker";
import type { BrokerAccount, BrokerExecution, BrokerOrder } from "../../types/trading";

export interface IbkrGatewayConfig {
  host: string;
  port?: number;
  clientId?: number;
  lastSuccessfulPort?: number;
  lastSuccessfulClientId?: number;
  marketDataType?: "auto" | "live" | "frozen" | "delayed" | "delayed-frozen";
}

export interface ResolvedIbkrGatewayConnection {
  host: string;
  port: number;
  clientId: number;
  requestedPort?: number;
  requestedClientId: number;
}

export interface IbkrSnapshot {
  status: BrokerConnectionStatus;
  accounts: BrokerAccount[];
  openOrders: BrokerOrder[];
  executions: BrokerExecution[];
  lastError?: string;
}
