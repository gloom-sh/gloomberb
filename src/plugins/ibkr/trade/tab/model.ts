import type { BrokerContractRef } from "../../../../types/instrument";
import type { TickerRecord } from "../../../../types/ticker";
import type { IbkrSnapshot } from "../../gateway/types";
import { normalizeContract, type TradeTicketState } from "../../trading/state";
import {
  formatContractLabel,
  truncateTradeText,
  type TradeTone,
} from "../utils";

export interface TradeTabLayout {
  wideLayout: boolean;
  previewPanelWidth: number | undefined;
  ticketPanelWidth: number;
  fieldsPerRow: number;
  fieldWidth: number;
  coreFieldWidth: number;
  orderFieldWidth: number;
  fieldTextWidth: number;
  previewTextWidth: number;
  previewMetricWidth: number;
}

export interface TradeContractDisplay {
  activeContract: BrokerContractRef;
  hasContract: boolean;
  contractValue: string;
  contractMeta: string;
}

export function resolveTradeTabLayout(width: number): TradeTabLayout {
  const wideLayout = width >= 112;
  const previewPanelWidth = wideLayout ? Math.min(38, Math.max(30, Math.floor(width * 0.28))) : undefined;
  const ticketPanelWidth = wideLayout ? Math.max(52, width - (previewPanelWidth ?? 0) - 5) : Math.max(34, width - 4);
  const fieldsPerRow = ticketPanelWidth >= 96 ? 4 : ticketPanelWidth >= 70 ? 3 : 2;
  const fieldWidth = Math.max(16, Math.floor((ticketPanelWidth - fieldsPerRow) / fieldsPerRow));
  const coreFieldWidth = ticketPanelWidth >= 76
    ? Math.max(16, Math.floor((ticketPanelWidth - 4) / 3))
    : fieldWidth;
  const orderFieldWidth = ticketPanelWidth >= 76
    ? Math.max(16, Math.floor((ticketPanelWidth - 5) / 4))
    : fieldWidth;
  const fieldTextWidth = Math.max(8, fieldWidth - 3);
  const previewTextWidth = Math.max(18, (previewPanelWidth ?? Math.max(34, width - 6)) - 4);
  const previewMetricWidth = Math.max(14, Math.floor(((previewPanelWidth ?? Math.max(34, width - 6)) - 6) / 2));

  return {
    wideLayout,
    previewPanelWidth,
    ticketPanelWidth,
    fieldsPerRow,
    fieldWidth,
    coreFieldWidth,
    orderFieldWidth,
    fieldTextWidth,
    previewTextWidth,
    previewMetricWidth,
  };
}

export function resolveTradeContractDisplay({
  ticketState,
  ticker,
  fieldTextWidth,
  fieldsPerRow,
}: {
  ticketState: TradeTicketState;
  ticker: TickerRecord | null;
  fieldTextWidth: number;
  fieldsPerRow: number;
}): TradeContractDisplay {
  const activeContract = ticketState.draft.contract.symbol
    ? ticketState.draft.contract
    : ticker ? normalizeContract(ticker) : ticketState.draft.contract;
  return {
    activeContract,
    hasContract: Boolean(activeContract.symbol),
    contractValue: truncateTradeText(formatContractLabel(activeContract), fieldTextWidth),
    contractMeta: truncateTradeText(
      ticketState.contractName || ticker?.metadata.name || "Using current ticker",
      Math.max(fieldTextWidth * Math.max(2, fieldsPerRow), 18),
    ),
  };
}

export function resolveTradeConnectionTone(gatewaySnapshot: IbkrSnapshot): TradeTone {
  switch (gatewaySnapshot.status.state) {
    case "connected": return "positive";
    case "error": return "negative";
    default: return "neutral";
  }
}

export function resolveTradeStatus({
  ticketState,
  gatewaySnapshot,
}: {
  ticketState: TradeTicketState;
  gatewaySnapshot: IbkrSnapshot;
}): { statusTone: TradeTone; statusText: string } {
  const statusTone: TradeTone = ticketState.lastError
    ? "negative"
    : ticketState.isSuccess
      ? "positive"
      : "accent";
  const statusText = ticketState.busy
    ? "Working…"
    : ticketState.lastError
      || ticketState.lastInfo
      || gatewaySnapshot.status.message
      || gatewaySnapshot.lastError
      || "Choose a workflow step or field, then preview before submit.";
  return { statusTone, statusText };
}

export function resolveTradePreviewDisplay(ticketState: TradeTicketState): {
  previewTone: TradeTone;
  previewHeading: string;
} {
  if (!ticketState.preview) {
    return { previewTone: "neutral", previewHeading: "Preview required" };
  }
  if (ticketState.preview.warningText) {
    return { previewTone: "negative", previewHeading: "Preview warning" };
  }
  return { previewTone: "positive", previewHeading: "Preview ready" };
}

export function resolveTradeNextStep({
  hasProfile,
  hasContract,
  hasAccount,
  hasPreview,
  editingOrderId,
}: {
  hasProfile: boolean;
  hasContract: boolean;
  hasAccount: boolean;
  hasPreview: boolean;
  editingOrderId?: number;
}): { nextStep: string; workflowTone: TradeTone } {
  const nextStep = !hasProfile
    ? "Choose profile"
    : !hasContract
      ? "Confirm ticker"
      : !hasAccount
        ? "Choose account"
        : !hasPreview
          ? "Run preview"
          : editingOrderId
            ? "Submit change"
            : "Submit order";
  const workflowTone: TradeTone = hasPreview
    ? "positive"
    : hasProfile && hasContract && hasAccount
      ? "accent"
      : "neutral";
  return { nextStep, workflowTone };
}
