import { FigureText } from "../../../components/ui/figure";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Badge, Button, Checkbox, FieldLabel, Notice, NumberField, SegmentedControl, TextField, useFieldRing, type SelectControl } from "../../../components";
import { useShortcut } from "../../../react/input";
import { blendHex } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { Quote } from "../../../types/financials";
import type { BrokerAccount, BrokerOrder, BrokerOrderPreview, BrokerOrderRequest, BrokerTradingCapabilities } from "../../../types/trading";
import { Box, ScrollBox, Text, TextAttributes, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { BrokerAccountPicker, type BrokerAccountChoice } from "./account-picker";
import { TicketCard, TicketOrderHeadline, TicketOrderSummary, TicketReceiptRow, TicketStatus, ticketMoney as money, ticketNumber as number, ticketTypeName as typeName } from "./ticket-parts";

export type TicketAction = "enable" | "review" | "back" | "confirm" | "refresh" | "orders" | "new" | "cancel" | "all" | "quantity25" | "quantity50" | "priceBid" | "priceMid" | "priceAsk" | "priceLast";
export type TicketField = "action" | "orderType" | "quantity" | "limitPrice" | "stopPrice" | "tif" | "outsideRth" | "typedConfirmation";
export interface TicketViewModel {
  brokerName: string; symbol: string; accounts: BrokerAccount[]; accountId?: string;
  accountChoices?: readonly BrokerAccountChoice[]; accountChoiceValue?: string;
  quote?: Quote; quoteData?: "realtime" | "delayed";
  phase: "enable" | "editing" | "previewing" | "review" | "submitting" | "result" | "cancel-review" | "cancelling";
  draft?: BrokerOrderRequest; preview?: BrokerOrderPreview; warnings: string[]; result?: BrokerOrder; error?: string;
  position?: number; avgCost?: number; positionPnl?: number; accountType?: string;
  tradingEnabled: boolean; typedConfirmation?: string; synthetic?: boolean; connected: boolean;
  capabilities?: BrokerTradingCapabilities; modifying?: boolean; defaultPriceLabel?: string; now?: number;
}
export interface BrokerTicketViewProps {
  model: TicketViewModel; width: number; height: number; focused: boolean;
  onEdit(field: TicketField, value: string | boolean): void;
  onAction(action: TicketAction): void;
  onAccountChange(accountId: string): void;
}
export function ticketQuoteAge(quote: Quote | undefined, now = Date.now()): string {
  const at = quote?.lastTradeTime ?? quote?.lastUpdated;
  if (!at || at > now) return "Age unknown";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  return seconds < 60 ? `${seconds}s old` : seconds < 3600 ? `${Math.floor(seconds / 60)}m old` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m old`;
}
const stateName: Record<string, string> = { NEW: "Working", WORKING: "Working", SUBMITTED: "Submitted", PENDING_NEW: "Submitted", PARTIALLY_FILLED: "Partially filled", FILLED: "Filled", REJECTED: "Rejected", PENDING_CANCEL: "Pending cancel", CANCELED: "Cancelled", CANCELLED: "Cancelled", UNKNOWN: "Outcome unknown" };

/** One ticket presentation, with the same review and focus gates on every renderer. */
export function BrokerTicketView({ model: m, width, height, focused, onEdit, onAction, onAccountChange }: BrokerTicketViewProps) {
  const c = useThemeColors();
  const native = useUiCapabilities().nativePaneChrome;
  const scope = `broker-ticket:${useId()}`;
  const wide = width >= 110;
  const account = m.accounts.find((item) => item.accountId === m.accountId);
  const mode = account?.tradingMode ?? "unknown";
  const live = mode !== "simulation";
  const modeColor = !account ? c.textDim : live ? c.negative : c.textBright;
  const modeLabel = !account ? "NO ACCOUNT" : mode === "simulation" ? "SIMULATION" : mode === "live" ? "LIVE" : "MODE UNKNOWN";
  const draft = m.draft;
  const sell = draft?.action === "SELL";
  const sideTone = sell ? "negative" : "positive";
  const side = sell ? "sell" : "buy";
  const currency = draft?.contract.currency ?? account?.currency ?? "USD";
  const unit = draft?.contract.secType === "OPT" ? "contracts" : "shares";
  const busy = ["previewing", "submitting", "cancelling"].includes(m.phase);
  const review = m.phase === "review" || m.phase === "submitting";
  const editing = m.phase === "editing" || m.phase === "previewing";
  const showLimit = draft?.orderType === "LMT" || draft?.orderType === "STP LMT";
  const showStop = draft?.orderType === "STP" || draft?.orderType === "STP LMT";
  const extendedHours = m.capabilities?.extendedHours && (!m.capabilities.extendedHoursTif || m.capabilities.extendedHoursTif.includes(draft?.tif ?? "DAY"));
  const inner = Math.max(28, width - (native ? 6 : 2));
  const formWidth = wide ? Math.floor((inner - 3) * 0.52) : inner;
  const summaryWidth = inner - formWidth - 3;
  const formInner = formWidth - (native ? wide ? 6 : 4 : 4);
  const rowGap = native ? wide ? 0.8 : 0.35 : 0;
  const [active, setActive] = useState("account");
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const accountControl = useRef<SelectControl>(null);
  const keys = useMemo(() => m.phase === "enable" ? ["enable", "back"] : editing ? ["account", "action", "orderType", "quantity", "quantity25", "quantity50", "all", ...(showLimit ? ["limitPrice", "priceBid", "priceMid", "priceAsk", "priceLast"] : []), ...(showStop ? ["stopPrice"] : []), "tif", ...(extendedHours ? ["outsideRth"] : []), "review"] : review ? ["back", ...(live ? ["typedConfirmation"] : []), "confirm"] : m.phase === "cancel-review" ? ["back", "cancel"] : ["refresh", "orders", "new"], [m.phase, editing, review, live, showLimit, showStop, extendedHours]);
  useEffect(() => { setActive(review || m.phase === "cancel-review" ? "back" : keys[0]!); }, [m.phase]);
  useEffect(() => { if (!keys.includes(active)) setActive(keys[0]!); }, [keys, active]);
  const { nodeRef } = useFieldRing({ ids: keys, activeId: active, onActivate: setActive, enabled: focused && !busy, scope, wrap: true, scrollRef });
  const confirmationSymbol = (draft?.contract.symbol ?? m.symbol).toUpperCase();
  const typedMatches = !live || m.typedConfirmation?.trim().toUpperCase() === confirmationSymbol;
  const holdingBlocked = sell && !m.capabilities?.shortSelling && (m.position === undefined || (draft?.quantity ?? 0) > Math.max(0, m.position));
  const canReview = m.connected && m.tradingEnabled && !!account && !!draft && draft.quantity > 0 && !holdingBlocked && !busy;
  const blockingPreview = !!m.preview?.errors?.length;
  const quickActions = ["all", "quantity25", "quantity50", "priceBid", "priceMid", "priceAsk", "priceLast"];
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped) return;
    if (event.name === "escape" && (review || m.phase === "cancel-review" || m.phase === "enable")) { event.preventDefault(); event.stopPropagation(); onAction("back"); return; }
    if (event.name !== "return" && event.name !== "enter") return;
    event.preventDefault(); event.stopPropagation();
    if (busy) return;
    if (active === "account") { accountControl.current?.open(); return; }
    if (active === "review" && canReview) onAction("review");
    else if (active === "confirm" && typedMatches && !blockingPreview && m.connected && m.tradingEnabled) onAction("confirm");
    else if (["back", "refresh", "orders", "new", "enable", "cancel", ...quickActions].includes(active)) onAction(active as TicketAction);
    else setActive(editing ? "review" : "confirm");
  }, { enabled: focused, phase: "before", scope, allowEditable: true });
  const action = (key: TicketAction, label: string, disabled = false, primary = false, tone: "positive" | "negative" | "neutral" = sideTone) => <Box ref={nodeRef(key)} onMouseDown={() => setActive(key)} flexShrink={0}>
    <Button label={label} variant={primary ? "primary" : "ghost"} tone={primary ? tone : undefined} height={native && primary ? 2 : 1} active={focused && active === key} disabled={disabled || busy} width={primary ? Math.max(16, formInner) : undefined} onPress={() => { setActive(key); onAction(key); }} />
  </Box>;
  const quick = (key: TicketAction, label: string, disabled = false) => <Box ref={nodeRef(key)} key={key}><Button label={label} variant="ghost" compact active={active === key && focused} disabled={disabled || busy} onPress={() => { setActive(key); onAction(key); }} /></Box>;
  const numeric = (key: TicketField, label: string, value: number | undefined, suffix: string) => <Box ref={nodeRef(key)} onMouseDown={() => setActive(key)} flexDirection="row" alignItems="center" gap={1}>
    <FieldLabel label={label} width={native ? 13 : 16} active={active === key} />
    <Box flexGrow={1}><NumberField value={value === undefined || !Number.isFinite(value) ? "" : String(value)} width={Math.max(10, formInner - 24)} focused={focused && active === key} active={active === key} onChange={(text) => onEdit(key, text)} onSubmit={() => setActive("review")} /></Box>
    <Text fg={c.textDim}>{suffix}</Text>
  </Box>;
  const quotePrice = (value: number | undefined) => value === undefined ? "Unavailable" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, Math.min(8, m.capabilities?.priceDecimals ?? 4)) });
  const sourceAt = m.quote?.lastTradeTime ?? m.quote?.lastUpdated;
  const updated = sourceAt && Number.isFinite(sourceAt) ? `${new Date(sourceAt).toISOString().slice(11, 19)} UTC` : "unknown";
  const delayed = m.quoteData !== "realtime" || m.quote?.dataSource !== "live";
  const source = `${m.brokerName}, ${delayed ? "delayed" : "real-time"} ${ticketQuoteAge(m.quote, m.now).replace(" old", "")}`;
  const resultStatus = m.result?.status.toUpperCase() ?? "UNKNOWN";
  const title = stateName[resultStatus] ?? m.result?.status ?? "Outcome unknown";
  const accountLine = <Box flexDirection="row" alignItems="center" gap={1}><Text fg={c.textDim} truncate>{account?.name ?? "Choose an account"}</Text><Badge label={modeLabel} color={modeColor} variant={live && account ? "solid" : "subtle"} /></Box>;
  const warnings = [...new Set(m.warnings)];
  if (warnings.includes("The broker quote is delayed.") && warnings.includes("The broker quote is stale. Prices may have changed.")) {
    warnings.splice(warnings.indexOf("The broker quote is delayed."), 1);
    warnings[ warnings.indexOf("The broker quote is stale. Prices may have changed.") ] = "Delayed, stale broker quote. Execution prices may differ.";
  }
  return <Box flexDirection="column" flexGrow={1} minHeight={0} height={height}>
    <Box flexShrink={0} border={["top"]} borderColor={modeColor} style={native ? { borderTop: `3px solid ${modeColor}` } : undefined}>
      <Box flexDirection="column" paddingX={native ? 3 : 1} paddingY={native ? wide ? 1 : 0.5 : 0} gap={native ? wide ? 0.65 : 0.2 : 0} backgroundColor={blendHex(c.bg, c.panel, 0.45)}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexDirection="row" alignItems="center" gap={1} flexGrow={1} minWidth={0}><Text fg={c.textBright} attributes={TextAttributes.BOLD}>{m.symbol}</Text><Text fg={c.textDim} truncate>{m.quote?.name && m.quote.name !== m.symbol ? m.quote.name : ""}</Text></Box>
          <Box ref={nodeRef("account")} flexShrink={0}><BrokerAccountPicker accounts={m.accountChoices ?? m.accounts.map((a) => ({ value: a.accountId, label: a.name, tradingMode: a.tradingMode }))} value={m.accountChoiceValue ?? m.accountId} onChange={onAccountChange} disabled={!editing || busy || m.modifying} active={active === "account" && focused} controlRef={accountControl} width={Math.min(36, Math.floor(width * 0.4))} /></Box>
          <Badge label={modeLabel} color={modeColor} variant={live && account ? "solid" : "subtle"} />
          {m.synthetic && wide ? <Badge label="SYNTHETIC" /> : null}
        </Box>
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={2}>
          <Box flexDirection="row" alignItems="center" gap={2}><FigureText style={{ fontSize: wide ? "40px" : "28px", lineHeight: 1.15 }}>{money(m.quote?.price, currency)}</FigureText><FigureText part="sub" change={m.quote?.change}>{m.quote ? `${m.quote.change >= 0 ? "+" : ""}${number(m.quote.change)} (${m.quote.changePercent >= 0 ? "+" : ""}${number(m.quote.changePercent)}%)` : ""}</FigureText></Box>
          <Box flexDirection="row" gap={1}>
            <Box flexDirection="column" paddingX={1} border={["bottom"]} borderColor={c.positive} style={native ? { borderBottom: `2px solid ${c.positive}` } : undefined}><Text fg={c.textDim}>{`Bid${m.quote?.bidSize !== undefined ? ` × ${number(m.quote.bidSize)}` : ""}`}</Text><Text fg={c.positive} attributes={TextAttributes.BOLD}>{quotePrice(m.quote?.bid)}</Text></Box>
            <Box flexDirection="column" paddingX={1} border={["bottom"]} borderColor={c.negative} style={native ? { borderBottom: `2px solid ${c.negative}` } : undefined}><Text fg={c.textDim}>{`Ask${m.quote?.askSize !== undefined ? ` × ${number(m.quote.askSize)}` : ""}`}</Text><Text fg={c.negative} attributes={TextAttributes.BOLD}>{quotePrice(m.quote?.ask)}</Text></Box>
          </Box>
        </Box>
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}><Badge label={source} tone={delayed ? "warning" : "neutral"} /><Text fg={c.textDim} truncate>{`Last updated ${updated}${m.synthetic && !wide ? " · SYNTHETIC" : ""}`}</Text></Box>
      </Box>
    </Box>
    <ScrollBox ref={scrollRef} flexGrow={1} scrollY>
      <Box flexDirection="column" paddingX={native ? 3 : 1} paddingY={native ? wide ? 1 : 0.4 : 0} gap={native ? wide ? 1 : 0.3 : 0}>
        <Box flexDirection="row" gap={1} flexWrap={native ? "wrap" : "nowrap"}>
          <Badge label={`Position ${m.position === undefined ? "unknown" : `${number(m.position)} ${unit === "shares" ? "sh" : "ct"}`}${m.avgCost === undefined ? "" : ` @ ${money(m.avgCost, currency)}`}`} />
          {m.positionPnl !== undefined ? <Badge label={`P&L ${money(m.positionPnl, currency)}`} tone={m.positionPnl >= 0 ? "positive" : "negative"} /> : null}
          <Badge label={`Buying power ${money(account?.buyingPower, currency)}`} />
          {m.accountType ? <Badge label={m.accountType} /> : null}
        </Box>
        {editing && draft ? <Box flexDirection={wide ? "row" : "column"} gap={wide ? 3 : 0} alignItems="flex-start">
          <TicketCard dense={!wide} width={formWidth} title={m.modifying ? "Modify order" : "Order details"}>
            <Box flexDirection="column" gap={rowGap}>
              {!m.connected ? <Notice variant="callout">Broker disconnected. Connect in Brokers.</Notice> : !m.tradingEnabled ? <Notice variant="callout">Trading is off for this profile.</Notice> : null}
              <Box ref={nodeRef("action")} onMouseDown={() => setActive("action")}><SegmentedControl value={draft.action} options={[{ value: "BUY", label: "Buy", tone: "positive", disabled: m.modifying }, { value: "SELL", label: "Sell", tone: "negative", disabled: m.modifying }]} size="large" width="100%" focused={focused && active === "action"} onChange={(v) => onEdit("action", v)} shortcutScope={scope} /></Box>
              <Box ref={nodeRef("orderType")} flexDirection="row" gap={1} alignItems="center" onMouseDown={() => setActive("orderType")}><FieldLabel label="Order type" width={native ? 13 : 16} active={active === "orderType"} /><SegmentedControl value={draft.orderType} options={(m.capabilities?.orderTypes ?? ["LMT"]).map((t) => ({ value: t, label: typeName[t] ?? t, disabled: m.modifying }))} focused={focused && active === "orderType"} onChange={(v) => onEdit("orderType", v)} shortcutScope={scope} /></Box>
              {numeric("quantity", "Quantity", draft.quantity, unit)}
              <Box flexDirection="row" justifyContent="flex-end" gap={1} paddingRight={9}>{quick("quantity25", "25%", sell && m.position === undefined)}{quick("quantity50", "50%", sell && m.position === undefined)}{quick("all", sell ? `Max ${number(m.position)}` : "Max", sell && !(m.position && m.position > 0))}</Box>
              {showLimit ? <>{numeric("limitPrice", "Limit price", draft.limitPrice, currency)}<Box flexDirection="row" justifyContent="flex-end" gap={1} paddingRight={9}>{quick("priceBid", "Bid", !m.quote?.bid)}{quick("priceMid", "Mid", !m.quote?.bid || !m.quote?.ask)}{quick("priceAsk", "Ask", !m.quote?.ask)}{quick("priceLast", "Last", !m.quote?.price)}</Box></> : null}
              {showStop ? numeric("stopPrice", "Stop price", draft.stopPrice, currency) : null}
              <Box flexDirection="row" alignItems="center" gap={1}><Box ref={nodeRef("tif")} flexDirection="row" gap={1} onMouseDown={() => setActive("tif")}><FieldLabel label="Time in force" width={native ? 13 : 16} active={active === "tif"} /><SegmentedControl value={draft.tif ?? "DAY"} options={(m.capabilities?.tif ?? ["DAY"]).map((v) => ({ value: v, label: v === "DAY" ? "Day" : v, disabled: m.modifying }))} focused={focused && active === "tif"} onChange={(v) => onEdit("tif", v)} shortcutScope={scope} /></Box>{extendedHours ? <Box ref={nodeRef("outsideRth")}><Checkbox label="Extended" checked={draft.outsideRth ?? false} disabled={m.modifying} active={focused && active === "outsideRth"} onChange={(v) => { setActive("outsideRth"); onEdit("outsideRth", v); }} /></Box> : null}</Box>
              {holdingBlocked ? <Notice tone="negative">{m.position === undefined ? "Refresh holdings before selling." : `You hold ${number(m.position)} ${unit}. Short selling is unavailable.`}</Notice> : null}
              {m.error ? <Notice variant="callout" tone="negative">{m.error}</Notice> : null}
              {!wide ? <TicketOrderSummary model={m} width={formInner} compact /> : null}
              <Box marginTop={native ? 0.5 : 0}>{m.tradingEnabled ? action("review", busy ? "Requesting preview..." : `Review ${side} ${number(draft.quantity)} ${m.symbol}`, !canReview, true) : action("enable", "Enable trading", !m.connected, true, "neutral")}</Box>
            </Box>
          </TicketCard>
          {wide ? <TicketOrderSummary model={m} width={summaryWidth} /> : null}
        </Box> : null}
        {m.phase === "enable" ? <Box flexDirection={wide ? "row" : "column"} gap={3}><TicketCard dense={!wide} width={formWidth} title="Enable trading">
          <FigureText>Review first. Confirm once.</FigureText>
          <Notice variant="callout" tone="warning">Orders can commit real money.</Notice>
          <Text fg={c.text} wrapText>Start with a simulation account. Every order gets its own broker preview and review.</Text>
          <Text fg={c.textDim} wrapText>LIVE orders also require a typed confirmation. Turn trading off at any time in Brokers.</Text>
          {accountLine}
          <Box marginTop={1} gap={1} flexDirection="column">{action("enable", "Enable trading", false, true, "neutral")}{action("back", "Keep read only")}</Box>
        </TicketCard>{wide ? <TicketOrderSummary model={m} width={summaryWidth} /> : null}</Box> : null}
        {review ? <Box flexDirection={wide ? "row" : "column"} gap={wide ? 3 : 0} alignItems="flex-start"><TicketCard dense={!wide} width={formWidth} title={m.modifying ? "Review replacement" : "Review order"}>
          <TicketOrderHeadline model={m} large />
          <Text fg={c.textDim}>{`${typeName[draft?.orderType ?? "LMT"]}${showLimit ? ` at ${money(draft?.limitPrice, currency)}` : ""}${showStop ? ` · Stop ${money(draft?.stopPrice, currency)}` : ""} · ${draft?.tif ?? "DAY"}`}</Text>
          {accountLine}
          <Box marginTop={native && wide ? 1 : 0} flexDirection="column" gap={native && wide ? 0.4 : 0}>
            <TicketReceiptRow label="Fees" value={money(m.preview?.fees, currency)} width={formInner} />
            <TicketReceiptRow label="Commission" value={money(m.preview?.commission, m.preview?.commissionCurrency ?? currency)} width={formInner} />
            <TicketReceiptRow label={m.preview?.buyingPowerAfter === undefined ? "Buying power impact" : "Buying power after"} value={money(m.preview?.buyingPowerAfter ?? m.preview?.buyingPowerImpact, currency)} width={formInner} />
          </Box>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" border={["top"]} borderColor={c.border} paddingTop={native && wide ? 0.7 : 0}><Text fg={c.textDim}>Estimated cost</Text><FigureText>{money(m.preview?.estimatedCost, currency)}</FigureText></Box>
          {warnings.map((warning, index) => <Notice key={index} variant="callout" tone="warning">{warning}</Notice>)}
          {m.preview?.errors?.map((error, index) => <Notice key={index} variant="callout" tone="negative">{error}</Notice>)}
          {live ? <TicketCard dense={!wide} width={formInner} accent={c.negative} compact><Box ref={nodeRef("typedConfirmation")} onMouseDown={() => setActive("typedConfirmation")}><FieldLabel label={`Type ${confirmationSymbol} to confirm a LIVE order`} active={active === "typedConfirmation"} /><TextField value={m.typedConfirmation ?? ""} onChange={(v) => onEdit("typedConfirmation", v)} focused={focused && active === "typedConfirmation"} active={active === "typedConfirmation"} width={Math.max(16, formInner - 6)} onSubmit={() => setActive("confirm")} /></Box></TicketCard> : null}
          {m.error ? <Notice tone="negative">{m.error}</Notice> : null}
          <Box flexDirection="column" gap={native && wide ? 0.6 : 0}>{action("back", "Edit order")}{action("confirm", busy ? "Submitting..." : m.modifying ? "Confirm replacement" : live ? "Place LIVE order" : "Place simulation order", !typedMatches || blockingPreview || !m.connected || !m.tradingEnabled, true, live ? "negative" : sideTone)}</Box>
        </TicketCard>{wide ? <TicketOrderSummary model={m} width={summaryWidth} receipt /> : null}</Box> : null}
        {m.phase === "cancel-review" || m.phase === "cancelling" ? <TicketCard dense={!wide} width={formWidth} title="Cancel this order?">
          <TicketOrderHeadline model={m} large />{accountLine}<Notice variant="callout">The order can still fill before the broker confirms cancellation.</Notice>
          {action("back", "Keep order")}{action("cancel", "Confirm cancellation", false, true, live ? "negative" : sideTone)}
        </TicketCard> : null}
        {m.phase === "result" ? <Box flexDirection={wide ? "row" : "column"} gap={3}><TicketCard dense={!wide} width={formWidth} title={title}>
          <TicketOrderHeadline model={m} large />{accountLine}<TicketStatus model={m} width={formInner} />
          {!["PARTIALLY_FILLED", "FILLED"].includes(resultStatus) ? <TicketReceiptRow label="Filled" value={number(m.result?.filled)} width={formInner} /> : null}
          <TicketReceiptRow label="Remaining" value={number(m.result?.remaining)} width={formInner} />
          {m.error && !["UNKNOWN", "REJECTED"].includes(resultStatus) ? <Notice variant="callout" tone="negative">{m.error}</Notice> : null}
          {action("refresh", "Refresh status", false, true, resultStatus === "UNKNOWN" ? "neutral" : sideTone)}
          <Box flexDirection="row" gap={1}>{action("orders", "Open orders")}{resultStatus !== "UNKNOWN" ? action("new", "New order") : null}</Box>
        </TicketCard>{wide ? <TicketOrderSummary model={m} width={summaryWidth} /> : null}</Box> : null}
      </Box>
    </ScrollBox>
  </Box>;
}
