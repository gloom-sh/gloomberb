import { FigureText } from "../../../components/ui/figure";
import type { ReactNode } from "react";
import { Badge, KeyValueRow, Notice, RatioBar, SectionHeading } from "../../../components";
import { blendHex } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import type { TicketViewModel } from "./ticket";

export const ticketNumber = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? "Unavailable" : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
export const ticketMoney = (value: number | undefined, currency = "USD") => value === undefined || !Number.isFinite(value) ? "Not reported" : new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
export const ticketTypeName: Record<string, string> = { MKT: "Market", LMT: "Limit", STP: "Stop", "STP LMT": "Stop limit" };
export function TicketCard({ children, width, accent, title, compact = false, dense = false }: { children: ReactNode; width?: number; accent?: string; title?: string; compact?: boolean; dense?: boolean }) {
  const c = useThemeColors(); const native = useUiCapabilities().nativePaneChrome;
  return <Box width={width} flexDirection="column" flexShrink={0} backgroundColor={native ? blendHex(c.bg, c.panel, 0.55) : undefined}
    border={native ? true : false} borderColor={accent ?? c.border} paddingX={native ? dense ? 1 : 2 : 1} paddingY={native ? dense ? 0.35 : compact ? 0.6 : 1 : 0}
    gap={native ? dense ? 0.2 : 0.7 : 0} style={native ? { borderRadius: 8, border: `1px solid ${accent ?? c.border}` } : undefined}>
    {title ? <SectionHeading title={title} /> : null}{children}
  </Box>;
}
export function TicketReceiptRow({ label, value, color, width, emphasis = false }: { label: string; value: string; width: number; color?: string; emphasis?: boolean }) {
  return <KeyValueRow label={label} value={value} width={width} labelWidth={Math.min(24, Math.floor(width * 0.48))} align="right" color={color} emphasis={emphasis} />;
}
export function TicketOrderHeadline({ model: m, large = false }: { model: TicketViewModel; large?: boolean }) {
  const c = useThemeColors(); const draft = m.draft; const side = draft?.action === "SELL" ? "Sell" : "Buy";
  return <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
    <FigureText part={large ? "value" : "sub"} fg={side === "Buy" ? c.positive : c.negative} style={large ? { fontSize: "24px" } : { fontSize: "16px", fontWeight: 700 }}>{side}</FigureText>
    <FigureText part={large ? "value" : "sub"} style={large ? { fontSize: "24px" } : { fontSize: "16px", fontWeight: 700 }}>{`${ticketNumber(draft?.quantity)} ${m.symbol}`}</FigureText>
  </Box>;
}
export function TicketOrderSummary({ model: m, width, compact = false, receipt = false }: { model: TicketViewModel; width: number; compact?: boolean; receipt?: boolean }) {
  const c = useThemeColors(); const draft = m.draft; const account = m.accounts.find((a) => a.accountId === m.accountId);
  const currency = draft?.contract.currency ?? account?.currency ?? "USD";
  const px = draft?.limitPrice ?? draft?.stopPrice ?? m.quote?.price;
  const total = draft && px !== undefined ? px * draft.quantity * Number(draft.contract.multiplier ?? 1) : undefined;
  const positionAfter = m.position !== undefined && draft ? m.position + (draft.action === "SELL" ? -draft.quantity : draft.quantity) : undefined;
  const powerAfter = m.preview?.buyingPowerAfter ?? (draft?.action === "BUY" && account?.buyingPower !== undefined && total !== undefined ? account.buyingPower - total : undefined);
  const sideColor = draft?.action === "SELL" ? c.negative : c.positive;
  if (compact) return <Box flexDirection="row" justifyContent="space-between" paddingX={1} backgroundColor={c.panel}>
    <Text fg={sideColor} attributes={TextAttributes.BOLD}>{`${draft?.action ?? "BUY"} ${ticketNumber(draft?.quantity)} ${m.symbol}`}</Text>
    <Text fg={c.textBright} attributes={TextAttributes.BOLD}>{`Est. ${ticketMoney(total, currency)}`}</Text>
  </Box>;
  const rowWidth = width - 6;
  if (receipt) return <TicketCard width={width} title="Account impact">
    <Text fg={c.textDim}>After this order fills</Text>
    <Box paddingY={1}><FigureText>{positionAfter === undefined ? "Unknown position" : `${ticketNumber(positionAfter)} ${draft?.contract.secType === "OPT" ? "contracts" : "shares"}`}</FigureText></Box>
    <TicketReceiptRow label="Current position" value={ticketNumber(m.position)} width={rowWidth} />
    <TicketReceiptRow label="Order quantity" value={`${draft?.action === "SELL" ? "−" : "+"}${ticketNumber(draft?.quantity)}`} color={sideColor} width={rowWidth} />
    <Box marginTop={1}><SectionHeading title="Buying power" /></Box>
    <TicketReceiptRow label="Before order" value={ticketMoney(account?.buyingPower, currency)} width={rowWidth} />
    <TicketReceiptRow label="Broker impact" value={ticketMoney(m.preview?.buyingPowerImpact, currency)} width={rowWidth} />
    <TicketReceiptRow label="After order" value={ticketMoney(m.preview?.buyingPowerAfter, currency)} width={rowWidth} />
  </TicketCard>;
  return <TicketCard width={width} title="Order summary">
    <TicketOrderHeadline model={m} large />
    <Text fg={c.textDim}>{`${ticketTypeName[draft?.orderType ?? "LMT"]} · ${draft?.tif ?? "DAY"}${draft?.outsideRth ? " · Extended hours" : ""}`}</Text>
    <Box flexDirection="column" paddingY={1}><Text fg={c.textDim}>Estimated order value</Text><FigureText style={{ fontSize: "30px" }}>{ticketMoney(total, currency)}</FigureText></Box>
    <TicketReceiptRow label="Quantity" value={`${ticketNumber(draft?.quantity)} ${draft?.contract.secType === "OPT" ? "contracts" : "shares"}`} width={rowWidth} />
    <TicketReceiptRow label="Price" value={draft?.orderType === "MKT" ? "At market" : ticketMoney(px, currency)} width={rowWidth} />
    <TicketReceiptRow label="Fees / commission" value={m.preview ? `${ticketMoney(m.preview.fees, currency)} / ${ticketMoney(m.preview.commission, currency)}` : "At review"} width={rowWidth} />
    <TicketReceiptRow label="Est. power after" value={ticketMoney(powerAfter, currency)} width={rowWidth} />
    <TicketReceiptRow label="Position after" value={positionAfter === undefined ? "Not reported" : `${ticketNumber(positionAfter)} ${draft?.contract.secType === "OPT" ? "contracts" : "shares"}`} width={rowWidth} />
    <Box marginTop={1}><Notice variant="callout" tone="warning">{m.quoteData !== "realtime" ? "Delayed broker quote. Execution prices may differ." : "Final cost and availability are checked at review."}</Notice></Box>
  </TicketCard>;
}
export function TicketStatus({ model: m, width }: { model: TicketViewModel; width: number }) {
  const c = useThemeColors(); const status = m.result?.status.toUpperCase() ?? "UNKNOWN";
  const filled = status === "FILLED"; const partial = status === "PARTIALLY_FILLED"; const active = !["UNKNOWN", "REJECTED", "CANCELLED", "CANCELED", "PENDING_CANCEL"].includes(status);
  const currentStep = filled ? 2 : ["SUBMITTED", "PENDING_NEW"].includes(status) ? 0 : 1;
  return <Box flexDirection="column" gap={1}>
    {active ? <Box flexDirection="row" gap={1} justifyContent="space-between">{["Submitted", "Working", "Filled"].map((label, index) => <Badge key={label} label={`${index + 1}  ${label}`} tone={index <= currentStep ? "positive" : "neutral"} variant={index === currentStep ? "solid" : "subtle"} />)}</Box> : null}
    {partial || filled ? <><RatioBar width={Math.max(10, width)} ratio={(m.result?.filled ?? 0) / Math.max(1, m.result?.quantity ?? 1)} color={c.positive} track thickness={6} /><Text fg={c.text}>{`${ticketNumber(m.result?.filled)} of ${ticketNumber(m.result?.quantity)} filled · Avg. ${ticketMoney(m.result?.avgFillPrice, m.draft?.contract.currency)}`}</Text></> : null}
    {status === "UNKNOWN" ? <Notice variant="callout" tone="warning">The broker has not confirmed the outcome. Refresh and reconcile in Orders. This order will not be retried automatically.</Notice> : null}
    {status === "REJECTED" ? <Notice variant="callout" tone="negative">{m.error ?? m.result?.warningText ?? "The broker rejected this order. Check the order before trying again."}</Notice> : null}
    {status === "PENDING_CANCEL" ? <Notice variant="callout" tone="warning">Cancellation requested. The order can still fill until the broker confirms.</Notice> : null}
  </Box>;
}
