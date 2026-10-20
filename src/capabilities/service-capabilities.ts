import type { BrokerConnectionStatus } from "../types/broker";
import type { QuoteSubscriptionTarget } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { BrokerOrder } from "../types/trading";

export const BROKER_CAPABILITY_ID = "broker.core";
export const NOTES_FILES_CAPABILITY_ID = "notes.files";
export const AI_RUNNER_CAPABILITY_ID = "ai.runner";

export type BrokerStatusEvent = {
  kind: "status";
  instanceId: string;
  status: BrokerConnectionStatus;
};

export type BrokerQuoteEvent = {
  kind: "quote";
  target: QuoteSubscriptionTarget;
  quote: Quote;
};

/** An order change, or the order stream going live or quiet, from `BrokerAdapter.subscribeOrders`. */
export type BrokerOrderEvent =
  | { kind: "order"; order: BrokerOrder }
  | { kind: "orders-live"; live: boolean };

export type BrokerRemoteEvent = BrokerStatusEvent | BrokerQuoteEvent | BrokerOrderEvent;

/**
 * What an AI runtime reports while it signs an account in.
 *
 * The runtime itself is a plugin's business: which providers exist, how they
 * authenticate, and what a run costs all change faster than the app releases.
 * The wire shape is the app's, because the desktop view and the Bun process
 * have to agree on it before either of them knows which plugin is on the
 * other end.
 */
export type AiAuthProgressEvent =
  | {
      type: "info";
      message: string;
      links?: readonly { url: string; label?: string }[];
    }
  | {
      type: "auth_url";
      url: string;
      instructions?: string;
    }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | {
      type: "progress";
      message: string;
    };

/**
 * One turn of an agent transcript, carried back so a thread survives a restart.
 * Only the discriminator is fixed here; the runtime that produced it owns the
 * rest and validates it on the way in.
 */
export interface AiRunnerAgentMessage {
  role: string;
  [key: string]: unknown;
}

export type AiRunnerEvent =
  | { kind: "chunk"; output: string }
  | { kind: "done"; output: string; agentMessages?: AiRunnerAgentMessage[] }
  | { kind: "cancelled" }
  | { kind: "error"; error: string }
  | { kind: "account-auth"; event: AiAuthProgressEvent }
  | { kind: "account-connected"; catalog: unknown }
  | { kind: "account-error"; error: string };
