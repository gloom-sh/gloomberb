import { FigureText } from "../../../components/ui/figure";
import type { ReactNode } from "react";
import { KeyValueRow, Notice, RatioBar, SectionHeading } from "../../../components";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import type { TicketViewModel } from "./ticket";
import { strategyLegLabel } from "./strategy";

export const ticketNumber = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? "Unavailable" : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
export const ticketMoney = (value: number | undefined, currency = "USD") => value === undefined || !Number.isFinite(value) ? "Not reported" : new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
export const ticketTypeName: Record<string, string> = { MKT: "Market", LMT: "Limit", STP: "Stop", "STP LMT": "Stop limit" };
/** `selectable`: a review or receipt whose figures someone may copy by hand. */
export function TicketSection({ children, width, title, selectable = false }: { children: ReactNode; width?: number; title?: string; selectable?: boolean }) {
  const native = useUiCapabilities().nativePaneChrome;
  return <Box width={width} flexDirection="column" flexShrink={0} gap={native ? 0.35 : 0} data-gloom-selectable={selectable ? "true" : undefined}>
    {title ? <SectionHeading title={title} /> : null}{children}
  </Box>;
}
export function TicketReceiptRow({ label, value, color, width, emphasis = false }: { label: string; value: string; width: number; color?: string; emphasis?: boolean }) {
  return <KeyValueRow label={label} value={value} width={width} labelWidth={Math.min(24, Math.floor(width * 0.48))} align="right" color={color} emphasis={emphasis} />;
}
export function TicketOrderHeadline({ model: m, large = false }: { model: TicketViewModel; large?: boolean }) {
  const c = useThemeColors(); const draft = m.draft; const side = draft?.action === "SELL" ? "Sell" : "Buy";
  return <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
    <FigureText part={large ? "value" : "sub"} fg={side === "Buy" ? c.positive : c.negative} style={large ? undefined : { fontSize: "var(--gloom-type-heading)", fontWeight: "var(--gloom-weight-bold)" }}>{side}</FigureText>
    <FigureText part={large ? "value" : "sub"} style={large ? undefined : { fontSize: "var(--gloom-type-heading)", fontWeight: "var(--gloom-weight-bold)" }}>{`${ticketNumber(draft?.quantity)} ${m.symbol}`}</FigureText>
  </Box>;
}
/** A spread's legs as they fill: side, contracts across all spreads, contract, and each leg's mid at this broker. */
/** `inset`: in the order form, the legs line up with the fields' labels. */
export function TicketLegs({ model: m, width, inset = false }: { model: TicketViewModel; width: number; inset?: boolean }) {
  const c = useThemeColors();
  const native = useUiCapabilities().nativePaneChrome;
  const draft = m.draft;
  if (!draft?.legs?.length) return null;
  const pad = inset && !native ? 2 : 0;
  return <Box flexDirection="column" width={width} paddingLeft={pad} data-gloom-selectable="true">
    {draft.legs.map((leg, index) => {
      const label = strategyLegLabel(leg, draft.quantity);
      const quote = m.legQuotes?.[index];
      const mid = quote && Number.isFinite(quote.bid) && Number.isFinite(quote.ask) ? (quote.bid! + quote.ask!) / 2 : undefined;
      return <Box key={index} flexDirection="row" gap={1}>
        <Text fg={leg.action === "BUY" ? c.positive : c.negative} attributes={TextAttributes.BOLD}>{label.side}</Text>
        <Text fg={c.text}>{label.contracts}</Text>
        <Box flexGrow={1} minWidth={0}><Text fg={c.text} truncate>{label.contract}</Text></Box>
        {mid !== undefined ? <Text fg={c.textDim}>{mid.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</Text> : null}
      </Box>;
    })}
  </Box>;
}
export function TicketOrderSummary({ model: m, width, compact = false, receipt = false }: { model: TicketViewModel; width: number; compact?: boolean; receipt?: boolean }) {
  const c = useThemeColors(); const draft = m.draft; const account = m.accounts.find((a) => a.accountId === m.accountId);
  const currency = draft?.contract.currency ?? account?.currency ?? "USD";
  const px = draft?.limitPrice ?? draft?.stopPrice ?? m.quote?.price;
  const total = m.phase === "result" ? m.preview?.estimatedCost === undefined ? undefined : Math.abs(m.preview.estimatedCost) : draft && px !== undefined ? px * draft.quantity * Number(draft.contract.multiplier ?? 1) : undefined;
  const strategy = !!draft?.legs?.length;
  const unit = strategy ? "spreads" : draft?.contract.secType === "OPT" ? "contracts" : "shares";
  // A spread changes each leg's position, which its legs list.
  const positionAfter = !strategy && m.position !== undefined && draft ? m.position + (draft.action === "SELL" ? -draft.quantity : draft.quantity) : undefined;
  const powerAfter = m.preview?.buyingPowerAfter;
  const sideColor = draft?.action === "SELL" ? c.negative : c.positive;
  if (compact && receipt) return <Box flexDirection="column">
    <Text fg={c.textDim}>Buying power · broker preview</Text>
    <TicketReceiptRow label={powerAfter === undefined ? "Impact" : "After order"} value={ticketMoney(powerAfter ?? m.preview?.buyingPowerImpact, currency)} width={width} />
  </Box>;
  if (compact) return <Box flexDirection="row" justifyContent="space-between" paddingX={1} backgroundColor={c.panel}>
    <Text fg={sideColor} attributes={TextAttributes.BOLD}>{`${draft?.action ?? "BUY"} ${ticketNumber(draft?.quantity)} ${m.symbol}`}</Text>
    <Text fg={c.textBright} attributes={TextAttributes.BOLD}>{`Est. ${ticketMoney(total, currency)}`}</Text>
  </Box>;
  const rowWidth = width;
  if (receipt) return <TicketSection width={width} title="Account impact" selectable>
    <Text fg={c.textDim}>After this order fills</Text>
    {strategy ? <Box paddingY={1}><TicketLegs model={m} width={rowWidth} /></Box> : <>
      <Box paddingY={1}><FigureText>{positionAfter === undefined ? "Unknown position" : `${ticketNumber(positionAfter)} ${unit}`}</FigureText></Box>
      <TicketReceiptRow label="Current position" value={ticketNumber(m.position)} width={rowWidth} />
      <TicketReceiptRow label="Order quantity" value={`${draft?.action === "SELL" ? "−" : "+"}${ticketNumber(draft?.quantity)}`} color={sideColor} width={rowWidth} />
    </>}
    <Box marginTop={1}><SectionHeading title="Buying power · broker preview" /></Box>
    <TicketReceiptRow label="Before order" value={ticketMoney(m.preview?.buyingPowerBefore ?? account?.buyingPower, currency)} width={rowWidth} />
    <TicketReceiptRow label="Broker impact" value={ticketMoney(m.preview?.buyingPowerImpact, currency)} width={rowWidth} />
    <TicketReceiptRow label="After order" value={ticketMoney(m.preview?.buyingPowerAfter, currency)} width={rowWidth} />
  </TicketSection>;
  return <TicketSection width={width} title="Order summary" selectable>
    <TicketOrderHeadline model={m} large />
    <Text fg={c.textDim}>{`${ticketTypeName[draft?.orderType ?? "LMT"]} · ${draft?.tif ?? "DAY"}${draft?.outsideRth ? " · Extended hours" : ""}`}</Text>
    <Box flexDirection="column" paddingY={1}><Text fg={c.textDim}>Estimated order value</Text><FigureText>{ticketMoney(total, currency)}</FigureText></Box>
    {strategy ? <TicketLegs model={m} width={rowWidth} /> : null}
    <TicketReceiptRow label="Quantity" value={`${ticketNumber(draft?.quantity)} ${unit}`} width={rowWidth} />
    <TicketReceiptRow label={strategy ? draft?.action === "SELL" ? "Net credit" : "Net debit" : "Price"} value={draft?.orderType === "MKT" ? "At market" : ticketMoney(px, currency)} width={rowWidth} />
    {m.phase === "result" ? <Text fg={c.textDim}>Estimates from order preview</Text> : null}
    <TicketReceiptRow label="Fees / commission" value={m.preview || m.phase === "result" ? `${ticketMoney(m.preview?.fees, currency)} / ${ticketMoney(m.preview?.commission, currency)}` : "At review"} width={rowWidth} />
    <TicketReceiptRow label="Broker power after" value={ticketMoney(powerAfter, currency)} width={rowWidth} />
    {strategy ? null : <TicketReceiptRow label="Position after" value={positionAfter === undefined ? "Not reported" : `${ticketNumber(positionAfter)} ${unit}`} width={rowWidth} />}
    {m.phase !== "result" ? <Box marginTop={1}><Notice variant="callout" tone="warning">{m.quoteData !== "realtime" ? "Delayed broker quote. Execution prices may differ." : "Final cost and availability are checked at review."}</Notice></Box> : null}
  </TicketSection>;
}
export function TicketStatus({ model: m, width }: { model: TicketViewModel; width: number }) {
  const native = useUiCapabilities().nativePaneChrome;
  const c = useThemeColors(); const status = m.result?.status.toUpperCase() ?? "UNKNOWN";
  const filled = status === "FILLED"; const partial = status === "PARTIALLY_FILLED"; const active = !["UNKNOWN", "REJECTED", "CANCELLED", "CANCELED", "PENDING_CANCEL"].includes(status);
  const currentStep = filled ? 2 : ["SUBMITTED", "PENDING_NEW"].includes(status) ? 0 : 1;
  return <Box flexDirection="column" gap={native ? 0.35 : 0}>
    {active ? <Box flexDirection="row" gap={1}>{["Submitted", "Working", "Filled"].map((label, index) => <Text key={label} fg={index <= currentStep ? c.positive : c.textDim} attributes={index === currentStep ? TextAttributes.BOLD : undefined}>{`${index ? "· " : ""}${label}`}</Text>)}</Box> : null}
    {partial || filled ? <><RatioBar width={Math.max(10, width)} ratio={(m.result?.filled ?? 0) / Math.max(1, m.result?.quantity ?? 1)} color={c.positive} track thickness={6} /><Text fg={c.text} wrapText>{`${ticketNumber(m.result?.filled)} of ${ticketNumber(m.result?.quantity)} filled · Avg. ${ticketMoney(m.result?.avgFillPrice, m.draft?.contract.currency)}`}</Text></> : null}
    {status === "UNKNOWN" ? <Notice variant="callout" tone="warning">Outcome unconfirmed. Refresh and reconcile in Orders. No automatic retry.</Notice> : null}
    {status === "REJECTED" ? <Notice variant="callout" tone="negative">{m.error ?? m.result?.warningText ?? "The broker rejected this order. Check the order before trying again."}</Notice> : null}
    {status === "PENDING_CANCEL" ? <Notice variant="callout" tone="warning">Cancellation requested. The order can still fill until the broker confirms.</Notice> : null}
  </Box>;
}
