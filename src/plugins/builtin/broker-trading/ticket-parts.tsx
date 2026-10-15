import type { ReactNode } from "react";
import { KeyValueRow, Notice, RatioBar, Section } from "../../../components";
import { Box } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import type { TicketViewModel } from "./ticket";

export const ticketNumber = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? "Unavailable" : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
export const ticketMoney = (value: number | undefined, currency = "USD") => value === undefined || !Number.isFinite(value) ? "Not reported" : new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
export const ticketTypeName: Record<string, string> = { MKT: "Market", LMT: "Limit", STP: "Stop", "STP LMT": "Stop limit" };
export function TicketSection({ children, width, title }: { children: ReactNode; width?: number; title?: string }) {
  return title ? <Section title={title} width={width}>{children}</Section> : <Box width={width} flexDirection="column" flexShrink={0}>{children}</Box>;
}
export function TicketReceiptRow({ label, value, width }: { label: string; value: string; width: number }) {
  return <KeyValueRow label={label} value={value} width={width} labelWidth={18} align="right" />;
}
export function TicketOrderHeadline({ model: m, width }: { model: TicketViewModel; width: number }) {
  const sell = m.draft?.action === "SELL";
  return <KeyValueRow width={width} labelWidth={18} label="Order" value={`${sell ? "Sell" : "Buy"} ${ticketNumber(m.draft?.quantity)} ${m.symbol}`} tone={sell ? "negative" : "positive"} align="right" />;
}
export function TicketStatus({ model: m, width }: { model: TicketViewModel; width: number }) {
  const colors = useThemeColors();
  const status = m.result?.status.toUpperCase() ?? "UNKNOWN";
  return <Box flexDirection="column">
    {status === "PARTIALLY_FILLED" || status === "FILLED" ? <>
      <RatioBar color={colors.positive} width={width} ratio={(m.result?.filled ?? 0) / Math.max(1, m.result?.quantity ?? 1)} track />
      <TicketReceiptRow label="Filled / Quantity" value={`${ticketNumber(m.result?.filled)} / ${ticketNumber(m.result?.quantity)}`} width={width} />
      <TicketReceiptRow label="Average fill" value={ticketMoney(m.result?.avgFillPrice, m.draft?.contract.currency)} width={width} />
    </> : null}
    {status === "UNKNOWN" ? <Notice tone="warning">Outcome unconfirmed. Refresh and reconcile in Orders. No automatic retry.</Notice> : null}
    {status === "REJECTED" ? <Notice tone="negative">{m.error ?? m.result?.warningText ?? "The broker rejected this order. Check the order before trying again."}</Notice> : null}
    {status === "PENDING_CANCEL" ? <Notice tone="warning">Cancellation requested. The order can still fill until the broker confirms.</Notice> : null}
  </Box>;
}
