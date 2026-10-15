import { DialogActions } from "../../../components/ui/dialog-actions";
import { wholeNumberStep } from "../../../components/ui/number-step";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Checkbox, FieldLabel, KeyValueRow, Notice, NumberField, SegmentedControl, SelectButton, TextField, useFieldRing, usePaneFooter, usePaneMenuItems, type PaneHint, type SelectControl } from "../../../components";
import { useShortcut } from "../../../react/input";
import { afterLayout, revealInScrollBox } from "../../../components/ui/reveal-in-scroll-box";
import { useThemeColors } from "../../../theme/theme-context";
import type { Quote } from "../../../types/financials";
import type { BrokerAccount, BrokerOrder, BrokerOrderPreview, BrokerOrderRequest, BrokerTradingCapabilities } from "../../../types/trading";
import { Box, ScrollBox, Text, useUiCapabilities, type BoxRenderable, type ScrollBoxRenderable } from "../../../ui";
import { useDialogState } from "../../../ui/dialog";
import { BrokerAccountPicker, type BrokerAccountChoice } from "./account-picker";
import { TicketSection, TicketOrderHeadline, TicketReceiptRow, TicketStatus, ticketMoney as money, ticketNumber as number, ticketTypeName as typeName } from "./ticket-parts";

export type TicketAction = "enable" | "review" | "submit" | "back" | "confirm" | "refresh" | "orders" | "new" | "cancel" | "all" | "quantity25" | "quantity50" | "priceBid" | "priceMid" | "priceAsk" | "priceLast";
export type TicketField = "action" | "orderType" | "quantity" | "limitPrice" | "stopPrice" | "tif" | "outsideRth" | "typedConfirmation" | "confirmOrders";
export interface TicketViewModel {
  brokerName: string; symbol: string; accounts: BrokerAccount[]; accountId?: string;
  accountChoices?: readonly BrokerAccountChoice[]; accountChoiceValue?: string;
  quote?: Quote; quoteData?: "realtime" | "delayed";
  phase: "enable" | "editing" | "previewing" | "review" | "submitting" | "result" | "cancel-review" | "cancelling";
  draft?: BrokerOrderRequest; preview?: BrokerOrderPreview; warnings: string[]; result?: BrokerOrder; error?: string;
  resultQuantities?: "confirmed" | "unconfirmed" | "last-known";
  position?: number; avgCost?: number; positionPnl?: number; accountType?: string;
  tradingEnabled: boolean; typedConfirmation?: string; synthetic?: boolean; connected: boolean;
  capabilities?: BrokerTradingCapabilities; modifying?: boolean; defaultPriceLabel?: string; now?: number;
  initialFocus?: string; focusRevision?: number;
  confirmOrders?: boolean;
}
export interface BrokerTicketViewProps {
  model: TicketViewModel; width: number; height: number; focused: boolean;
  onEdit(field: TicketField, value: string | boolean): void;
  onAction(action: TicketAction): void;
  onAccountChange(accountId: string): void;
  onCapture?(capturing: boolean): void;
  docked?: boolean;
  blocked?: boolean;
  onClose?(): void;
}
export function ticketQuoteAge(quote: Quote | undefined, now = Date.now()): string {
  const at = quote?.lastTradeTime ?? quote?.lastUpdated;
  if (!at || at > now) return "Age unknown";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  return seconds < 60 ? `${seconds}s old` : seconds < 3600 ? `${Math.floor(seconds / 60)}m old` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m old`;
}
const stateName: Record<string, string> = { NEW: "Working", WORKING: "Working", SUBMITTED: "Submitted", PENDING_NEW: "Submitted", PARTIALLY_FILLED: "Partially filled", FILLED: "Filled", REJECTED: "Rejected", PENDING_CANCEL: "Pending cancel", CANCELED: "Cancelled", CANCELLED: "Cancelled", UNKNOWN: "Outcome unknown" };
const tifName: Record<string, string> = { DAY: "Day", GTC: "Good til cancelled", IOC: "Immediate or cancel", FOK: "Fill or kill", EXTENDED_HOURS: "Extended hours", AT_THE_OPENING: "At the opening", AT_THE_CLOSE: "At the close" };

/** Preserve intermediate edits such as an empty field or trailing decimal point. */
function TicketNumberInput({ value, focused, onChange, ...props }: {
  value: number | undefined; focused: boolean; active: boolean; width: number; accessibleLabel: string;
  onChange(value: string): void; onSubmit(): void;
  disabled: boolean; step: number; min: number; max?: number;
}) {
  const format = (next: number | undefined) => next === undefined || !Number.isFinite(next) ? "" : String(next);
  const [raw, setRaw] = useState(() => format(value));
  const rawRef = useRef(raw);
  useEffect(() => {
    const equivalent = rawRef.current === "" ? value === undefined || Number.isNaN(value) : Object.is(Number(rawRef.current), value);
    if (!focused || !equivalent) {
      rawRef.current = format(value);
      setRaw(rawRef.current);
    }
  }, [value, focused]);
  return <NumberField {...props} value={raw} focused={focused} onChange={(next) => {
    if (next === rawRef.current) return;
    rawRef.current = next; setRaw(next); onChange(next);
  }} />;
}

/** One ticket presentation, with the same review and focus gates on every renderer. */
export function BrokerTicketView({ model: m, width, height, focused, onEdit, onAction, onAccountChange, onCapture, docked = false, blocked = false, onClose }: BrokerTicketViewProps) {
  const c = useThemeColors();
  const native = useUiCapabilities().nativePaneChrome;
  const dialogOpen = useDialogState((state) => state.isOpen);
  const scope = `broker-ticket:${useId()}`;
  const wide = width >= 110;
  const account = m.accounts.find((item) => item.accountId === m.accountId);
  const mode = account?.tradingMode ?? "unknown";
  const live = mode !== "simulation";
  const draft = m.draft;
  const sell = draft?.action === "SELL";
  const currency = draft?.contract.currency ?? account?.currency ?? "USD";
  const unit = draft?.contract.secType === "OPT" ? "contracts" : "shares";
  const busy = blocked || ["previewing", "submitting", "cancelling"].includes(m.phase);
  const fast = mode === "simulation" && m.confirmOrders === false && !m.modifying;
  const fastSubmitting = m.phase === "submitting" && fast && !m.warnings.length && !m.preview?.errors?.length;
  const review = m.phase === "review" || m.phase === "submitting" && !fastSubmitting;
  const editing = m.phase === "editing" || m.phase === "previewing" || fastSubmitting;
  const showLimit = draft?.orderType === "LMT" || draft?.orderType === "STP LMT";
  const showStop = draft?.orderType === "STP" || draft?.orderType === "STP LMT";
  const extendedHours = m.capabilities?.extendedHours && (!m.capabilities.extendedHoursTif || m.capabilities.extendedHoursTif.includes(draft?.tif ?? "DAY"));
  const inner = Math.max(28, width - 2);
  const formWidth = wide ? Math.min(74, inner) : inner;
  const formInner = formWidth;
  const labelWidth = docked ? 10 : 14;
  const [active, setActive] = useState("account");
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const reviewControlRef = useRef<BoxRenderable | null>(null);
  const accountControl = useRef<SelectControl>(null);
  const tifControl = useRef<SelectControl>(null);
  const orderTypeControl = useRef<SelectControl>(null);
  const resultStatus = m.result?.status.toUpperCase() ?? "UNKNOWN";
  const keys = useMemo(() => m.phase === "enable" ? ["enable", "back"] : editing ? ["account", "action", "orderType", "quantity", "quantity25", "quantity50", "all", ...(showLimit ? ["limitPrice", "priceBid", "priceMid", "priceAsk", "priceLast"] : []), ...(showStop ? ["stopPrice"] : []), "tif", ...(extendedHours ? ["outsideRth"] : []), ...(mode === "simulation" && !m.modifying ? ["confirmOrders"] : []), m.tradingEnabled ? "review" : "enable"] : review ? ["back", ...(live ? ["typedConfirmation"] : []), "confirm"] : m.phase === "cancel-review" ? ["back", "cancel"] : resultStatus === "REJECTED" ? ["back", "refresh", "orders"] : resultStatus === "FILLED" ? ["new", "refresh", "orders"] : resultStatus === "UNKNOWN" ? ["refresh", "orders"] : ["refresh", "orders", "new"], [m.phase, editing, review, live, showLimit, showStop, extendedHours, resultStatus, m.tradingEnabled, mode, m.modifying]);
  const previousFocus = useRef<{ phase: TicketViewModel["phase"]; revision?: number } | undefined>(undefined);
  useEffect(() => {
    if (previousFocus.current?.phase !== m.phase || previousFocus.current?.revision !== m.focusRevision) {
      previousFocus.current = { phase: m.phase, revision: m.focusRevision };
      setActive(review || m.phase === "cancel-review" ? "back" : editing && m.initialFocus && keys.includes(m.initialFocus) ? m.initialFocus : keys[0]!);
    } else if (!keys.includes(active)) setActive(keys[0]!);
  }, [m.phase, m.focusRevision, keys, active]);
  const { nodeRef } = useFieldRing({ ids: keys, activeId: active, onActivate: setActive, enabled: focused && !busy && !dialogOpen, scope, scrollRef });
  useEffect(() => {
    if (active === "review" && editing) return afterLayout(() => revealInScrollBox(scrollRef.current, reviewControlRef.current));
  }, [active, editing, m.focusRevision]);
  const confirmationSymbol = (draft?.contract.symbol ?? m.symbol).toUpperCase();
  const typedMatches = !live || m.typedConfirmation?.trim().toUpperCase() === confirmationSymbol;
  const holdingBlocked = sell && !m.capabilities?.shortSelling && (m.position === undefined || (draft?.quantity ?? 0) > Math.max(0, m.position));
  const validPrice = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value > 0;
  const canReview = m.connected && m.tradingEnabled && !!account && !!draft && validPrice(draft.quantity) && !holdingBlocked && !busy
    && (!showLimit || validPrice(draft.limitPrice)) && (!showStop || validPrice(draft.stopPrice));
  const blockingPreview = !!m.preview?.errors?.length;
  const canConfirm = review && typedMatches && !blockingPreview && m.connected && m.tradingEnabled && !busy;
  const textActive = ["quantity", "limitPrice", "stopPrice", "typedConfirmation"].includes(active);
  // Leaving a field must return h/l to the research strip, including after a command.
  useEffect(() => {
    onCapture?.(focused && textActive);
    return () => onCapture?.(false);
  }, [focused, textActive, onCapture]);
  const quickDisabled = (key: TicketAction) => key === "priceBid" ? !validPrice(m.quote?.bid) : key === "priceAsk" ? !validPrice(m.quote?.ask)
    : key === "priceMid" ? !validPrice(m.quote?.bid) || !validPrice(m.quote?.ask) : key === "priceLast" ? !validPrice(m.quote?.price)
    : sell ? m.position === undefined || m.position <= 0 : !account || !validPrice(account.buyingPower) || !validPrice(m.quote?.ask ?? m.quote?.price);
  const quickActions: TicketAction[] = ["all", "quantity25", "quantity50", "priceBid", "priceMid", "priceAsk", "priceLast"];
  const activate = () => {
    if (busy) return;
    if (active === "account") { if (!m.modifying) accountControl.current?.open(); return; }
    if (active === "orderType") { if (!m.modifying) orderTypeControl.current?.open(); return; }
    if (active === "confirmOrders") { if (mode === "simulation" && !m.modifying) onEdit("confirmOrders", m.confirmOrders === false); return; }
    if (active === "tif") { if (!m.modifying) tifControl.current?.open(); return; }
    if (active === "outsideRth") { if (!m.modifying && extendedHours) onEdit("outsideRth", !draft?.outsideRth); return; }
    if (active === "review") { if (canReview) onAction("submit"); return; }
    if (active === "confirm") { if (canConfirm) onAction("confirm"); return; }
    if (quickActions.includes(active as TicketAction)) { if (!quickDisabled(active as TicketAction)) onAction(active as TicketAction); return; }
    if (active === "enable" && !m.connected) return;
    if (["back", "refresh", "orders", "new", "enable", "cancel"].includes(active)) onAction(active as TicketAction);
    else setActive(editing ? m.tradingEnabled ? "review" : "enable" : "confirm");
  };
  const keyAction = (key: string, label: string, run: () => void, disabled = false): PaneHint => ({ id: `ticket-${key}`, key, label, onPress: run, disabled: busy || disabled });
  const editShortcut = (key: string, label: string, field: TicketField, value: string | boolean, disabled = false) => keyAction(key, label, () => { setActive(field); onEdit(field, value); }, disabled);
  const actionShortcut = (key: string, label: string, action: TicketAction, disabled = false) => keyAction(key, label, () => { setActive(action); onAction(action); }, disabled);
  const shortcuts: PaneHint[] = editing ? [
    editShortcut("b", "uy", "action", "BUY", !!m.modifying), editShortcut("s", "ell", "action", "SELL", !!m.modifying),
    m.tradingEnabled ? actionShortcut("r", "eview", "review", !canReview) : actionShortcut("e", "nable trading", "enable", !m.connected), actionShortcut("o", "rders", "orders"),
    keyAction("a", "ccount", () => { setActive("account"); accountControl.current?.open(); }, !!m.modifying),
    keyAction("t", "ime in force", () => { setActive("tif"); tifControl.current?.open(); }, !!m.modifying),
    ...(["MKT", "LMT", "STP", "STP LMT"] as const).map((type, index) => editShortcut(String(index + 1), typeName[type]!, "orderType", type, !!m.modifying || !m.capabilities?.orderTypes.includes(type))),
    ...([["5", "25%", "quantity25"], ["6", "50%", "quantity50"], ["7", "Max", "all"]] as const).map(([key, label, action]) => actionShortcut(key, label, action, quickDisabled(action))),
    ...(showLimit || showStop ? ([["8", "Bid", "priceBid"], ["9", "Mid", "priceMid"], ["0", "Ask", "priceAsk"], ["p", "Last", "priceLast"]] as const).map(([key, label, action]) => actionShortcut(key, label, action, quickDisabled(action))) : []),
    ...(extendedHours ? [editShortcut("x", "Extended", "outsideRth", !draft?.outsideRth, !!m.modifying)] : []),
  ] : review ? [actionShortcut("e", "dit", "back"), actionShortcut("o", "rders", "orders")]
    : m.phase === "enable" ? [actionShortcut("e", "nable", "enable", !m.connected)]
    : m.phase === "cancel-review" ? [actionShortcut("e", "dit", "back")]
    : m.phase === "result" ? [
      ...(resultStatus === "REJECTED" ? [actionShortcut("e", "dit", "back")] : []),
      actionShortcut("r", "efresh", "refresh"), actionShortcut("o", "rders", "orders"),
      ...(!["UNKNOWN", "REJECTED"].includes(resultStatus) ? [actionShortcut("n", "ew", "new")] : []),
    ] : [];
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped) return;
    if (event.ctrl || event.meta || event.alt || event.super) return;
    if (event.name === "escape" && !busy && (review || m.phase === "cancel-review" || m.phase === "enable" || textActive)) {
      event.preventDefault(); event.stopPropagation();
      if (editing) setActive("account"); else onAction("back");
      return;
    }
    if (event.name === "escape" && onClose) { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (["return", "enter"].includes(event.name ?? "") || event.name === "space" && !textActive && !event.targetEditable) {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) activate();
      return;
    }
    if (event.shift || event.targetEditable || textActive) return;
    const shortcut = shortcuts.find((item) => item.key === event.name);
    if (!shortcut) return;
    event.preventDefault(); event.stopPropagation();
    if (!shortcut.disabled) shortcut.onPress?.();
  }, { enabled: focused && !dialogOpen, phase: "before", scope, allowEditable: true });
  // Keep the full keyboard map without turning the footer into another toolbar.
  const footerKeys = m.phase === "result" ? ["o", resultStatus === "REJECTED" ? "e" : "n"] : editing ? ["o"] : [];
  usePaneFooter(scope, () => ({
    info: busy ? [{ id: "progress", parts: [{ text: blocked ? "Order action pending..." : m.phase === "previewing" ? "Requesting broker preview..." : m.phase === "cancelling" ? "Cancelling..." : "Submitting..." }] }] : undefined,
    hints: busy || textActive ? [] : shortcuts.filter((hint) => footerKeys.includes(hint.key)),
  }), [m, busy, textActive]);
  usePaneMenuItems(scope + ":keys", () => [
    ...shortcuts.filter((hint) => !footerKeys.includes(hint.key)).map((hint) => ({
      id: hint.id, label: hint.key.length === 1 && /^[a-z]/.test(hint.label) ? hint.key + hint.label : hint.label,
      accelerator: hint.key, enabled: !hint.disabled, onSelect: hint.onPress,
    })),
    { id: "ticket-next", label: "Next field", accelerator: "Tab" },
    { id: "ticket-previous", label: "Previous field", accelerator: "Shift+Tab" },
    { id: "ticket-activate", label: "Activate focused control", accelerator: "Enter", onSelect: activate, enabled: !busy },
    ...(onClose ? [{ id: "ticket-close", label: "Close trade panel", accelerator: "Esc", onSelect: onClose }] : []),
  ], [m, busy, active, textActive, canConfirm, canReview]);
  const action = (key: TicketAction, label: string, disabled = false, primary = false) => <Box ref={(node) => { nodeRef(key)(node); if (key === "review") reviewControlRef.current = node; }} onMouseDown={() => setActive(key)} flexShrink={0}>
    <Button label={label} displayLabel={!native && focused && active === key ? `> ${label}` : undefined} variant={key === "cancel" || key === "confirm" && live ? "danger" : primary ? "primary" : "secondary"} active={focused && active === key} disabled={disabled || busy} onPress={() => { setActive(key); onAction(key === "review" ? "submit" : key); }} />
  </Box>;
  const quick = (key: TicketAction, label: string, disabled = false) => <Box ref={nodeRef(key)} key={key}><Button label={label} displayLabel={!native && focused && active === key ? `> ${label}` : undefined} variant="plain" compact active={active === key && focused} disabled={disabled || busy} onPress={() => { setActive(key); onAction(key); }} /></Box>;
  const numeric = (key: TicketField, label: string, value: number | undefined) => {
    const quantity = key === "quantity";
    const reportedStep = m.capabilities?.quantityStep ?? 1;
    const quantityStep = m.capabilities?.fractionalQuantity ? reportedStep : wholeNumberStep(reportedStep) ?? NaN;
    // Decimal precision is not a declared exchange tick. The fallback is an editing convenience only.
    const decimals = m.capabilities?.priceDecimals;
    const priceStep = m.capabilities?.priceStep ?? (decimals !== undefined && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? 10 ** -decimals : 0.01);
    const step = quantity ? quantityStep : priceStep;
    return <Box ref={nodeRef(key)} onMouseDown={() => { if (!busy) setActive(key); }} flexDirection="row" alignItems="center" gap={1}>
      <FieldLabel label={label} width={labelWidth} active={active === key} />
      <Box flexGrow={1}><TicketNumberInput accessibleLabel={key === "limitPrice" ? "Limit price" : key === "stopPrice" ? "Stop price" : label} value={value} width={Math.max(14, formInner - labelWidth - 1)} focused={focused && active === key && !busy} active={active === key} disabled={busy}
        step={step} min={quantity ? Math.max(step, m.capabilities?.minQuantity ?? step) : step} max={quantity && sell && !m.capabilities?.shortSelling ? Math.max(0, m.position ?? 0) : undefined}
        onChange={(text) => { if (!busy) onEdit(key, text); }} onSubmit={() => setActive(m.tradingEnabled ? "review" : "enable")} /></Box>
    </Box>;
  };
  const quotePrice = (value: number | undefined) => value === undefined ? "Unavailable" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, Math.min(8, m.capabilities?.priceDecimals ?? 4)) });
  const delayed = m.quoteData !== "realtime" || m.quote?.dataSource !== "live";
  const title = stateName[resultStatus] ?? m.result?.status ?? "Outcome unknown";
  const warnings = [...new Set(m.warnings)];
  if (warnings.includes("The broker quote is delayed.") && warnings.includes("The broker quote is stale. Prices may have changed.")) {
    warnings.splice(warnings.indexOf("The broker quote is delayed."), 1);
    warnings[ warnings.indexOf("The broker quote is stale. Prices may have changed.") ] = "Delayed, stale broker quote. Execution prices may differ.";
  }
  return <Box flexDirection="column" flexGrow={1} minHeight={0} height={height}>
    <ScrollBox ref={scrollRef} flexGrow={1} scrollY>
      <Box flexDirection="column" paddingX={1}>
        <Box ref={nodeRef("account")} onMouseDown={() => { if (editing) setActive("account"); }}>
          <BrokerAccountPicker accounts={m.accountChoices ?? m.accounts.map((a) => ({ value: a.accountId, label: a.name, tradingMode: a.tradingMode }))} value={m.accountChoiceValue ?? m.accountId} onChange={onAccountChange} disabled={!editing || busy || m.modifying} active={active === "account" && focused} controlRef={accountControl} width={inner} showMode />
        </Box>
        {editing ? <>
          <KeyValueRow label="Bid / Ask" value={`${quotePrice(m.quote?.bid)} / ${quotePrice(m.quote?.ask)}`} width={inner} align="right" />
          <KeyValueRow label="Quote" value={`${delayed ? "Delayed" : "Real-time"} · ${ticketQuoteAge(m.quote)}`} width={inner} align="right" />
        </> : null}
        {editing && draft ? <TicketSection width={formWidth} title={m.modifying ? "Modify order" : docked ? undefined : "Order details"}>
          {!m.connected ? <Notice>Broker disconnected. Connect in Brokers.</Notice> : !m.tradingEnabled ? <Notice>Trading is off for this profile.</Notice> : null}
          <Box ref={nodeRef("action")} flexDirection="row" onMouseDown={() => setActive("action")}>
            {!native ? <FieldLabel label="" width={2} active={focused && active === "action"} /> : null}
            <SegmentedControl accessibleLabel="Order side" value={draft.action} options={[{ value: "BUY", label: "Buy", disabled: busy || m.modifying }, { value: "SELL", label: "Sell", disabled: busy || m.modifying }]} focused={focused && active === "action"} onChange={(v) => onEdit("action", v)} shortcutScope={scope} />
          </Box>
          <Box ref={nodeRef("orderType")} flexDirection="row" gap={1} alignItems="center" onMouseDown={() => { if (!busy) setActive("orderType"); }}>
            <FieldLabel label="Type" width={labelWidth} active={active === "orderType"} />
            <SelectButton label="Order type" showLabel={false} variant="field" width={Math.max(14, formInner - labelWidth - 1)} value={draft.orderType} options={(m.capabilities?.orderTypes ?? ["LMT"]).map((t) => ({ value: t, label: typeName[t] ?? t }))} disabled={busy || m.modifying} emphasized={focused && active === "orderType"} controlRef={orderTypeControl} onFocus={() => setActive("orderType")} onChange={(v) => onEdit("orderType", v)} />
          </Box>
          {numeric("quantity", "Quantity", draft.quantity)}
          <Box flexDirection="row" justifyContent="flex-end" gap={1}>{quick("quantity25", "25%", quickDisabled("quantity25"))}{quick("quantity50", "50%", quickDisabled("quantity50"))}{quick("all", "Max", quickDisabled("all"))}</Box>
          {showLimit ? <>{numeric("limitPrice", docked ? "Limit" : "Limit price", draft.limitPrice)}<Box flexDirection="row" justifyContent="flex-end" gap={1}>{quick("priceBid", "Bid", quickDisabled("priceBid"))}{quick("priceMid", "Mid", quickDisabled("priceMid"))}{quick("priceAsk", "Ask", quickDisabled("priceAsk"))}{quick("priceLast", "Last", quickDisabled("priceLast"))}</Box></> : null}
          {showStop ? numeric("stopPrice", docked ? "Stop" : "Stop price", draft.stopPrice) : null}
          <Box ref={nodeRef("tif")} flexDirection="row" gap={1} alignItems="center" onMouseDown={() => setActive("tif")}>
            <FieldLabel label="TIF" width={labelWidth} active={active === "tif"} />
            <SelectButton label="Time in force" title="Time in force" showLabel={false} variant="field" width={Math.max(14, formInner - labelWidth - 1)} value={draft.tif ?? "DAY"} options={(m.capabilities?.tif ?? ["DAY"]).map((v) => ({ value: v, label: tifName[v] ?? v, short: ({ DAY: "Day", GTC: "GTC", IOC: "IOC", FOK: "FOK", EXTENDED_HOURS: "Extended", AT_THE_OPENING: "At open", AT_THE_CLOSE: "At close" } as Record<string, string>)[v] }))} disabled={busy || m.modifying} emphasized={focused && active === "tif"} controlRef={tifControl} onFocus={() => setActive("tif")} onChange={(v) => onEdit("tif", v)} />
          </Box>
          {extendedHours ? <Box ref={nodeRef("outsideRth")}><Checkbox label="Outside RTH" checked={draft.outsideRth ?? false} disabled={busy || m.modifying} active={focused && active === "outsideRth"} onChange={(v) => { setActive("outsideRth"); onEdit("outsideRth", v); }} /></Box> : null}
          {holdingBlocked ? <Notice tone="negative">{m.position === undefined ? "Refresh holdings before selling." : `You hold ${number(m.position)} ${unit}. Short selling is unavailable.`}</Notice> : null}
          {m.error ? <Notice tone="negative">{m.error}</Notice> : null}
          {mode === "simulation" && !m.modifying ? <Box ref={nodeRef("confirmOrders")} flexDirection="column">
            <Checkbox label="Confirm orders" checked={!fast} disabled={busy} active={focused && active === "confirmOrders"} onChange={(value) => { setActive("confirmOrders"); onEdit("confirmOrders", value); }} />
            {fast ? <Notice tone="warning">SIM one-click · preview required</Notice> : null}
          </Box> : null}
          <TicketReceiptRow label="Est. cost" value={money((draft.limitPrice ?? draft.stopPrice ?? m.quote?.price ?? NaN) * draft.quantity * Number(draft.contract.multiplier ?? 1), currency)} width={formInner} />
          <TicketReceiptRow label="Position" value={m.position === undefined ? "Unknown" : `${number(m.position)} ${unit}`} width={formInner} />
          <TicketReceiptRow label="Buying power" value={money(account?.buyingPower, currency)} width={formInner} />
          <DialogActions>{m.tradingEnabled ? action("review", busy ? blocked ? "Order action pending..." : m.phase === "submitting" ? "Submitting..." : "Requesting preview..." : `${sell ? "Sell" : "Buy"} ${number(draft.quantity)} ${m.symbol}`, !canReview, true) : action("enable", "Enable trading", !m.connected, true)}</DialogActions>
        </TicketSection> : null}
        {m.phase === "enable" ? <TicketSection width={formWidth} title="Enable trading">
          <Notice tone="warning">Orders can commit real money.</Notice>
          <Text wrapText>Every order gets a broker preview. LIVE orders also require a typed confirmation.</Text>
          <DialogActions wrap>{action("enable", "Enable trading", false, true)}{action("back", "Keep read only")}</DialogActions>
        </TicketSection> : null}
        {review ? <TicketSection width={formWidth} title={m.modifying ? "Review replacement" : "Review order"}>
          <TicketOrderHeadline model={m} width={formInner} />
          <TicketReceiptRow label="Type / TIF" value={`${typeName[draft?.orderType ?? "LMT"]} / ${draft?.tif ?? "DAY"}`} width={formInner} />
          {showLimit ? <TicketReceiptRow label="Limit" value={money(draft?.limitPrice, currency)} width={formInner} /> : null}
          {showStop ? <TicketReceiptRow label="Stop" value={money(draft?.stopPrice, currency)} width={formInner} /> : null}
          <TicketReceiptRow label="Estimated cost" value={money(m.preview?.estimatedCost, currency)} width={formInner} />
          <TicketReceiptRow label="Fees" value={money(m.preview?.fees, currency)} width={formInner} />
          <TicketReceiptRow label="Commission" value={money(m.preview?.commission, m.preview?.commissionCurrency ?? currency)} width={formInner} />
          <TicketReceiptRow label="Buying power after" value={money(m.preview?.buyingPowerAfter, currency)} width={formInner} />
          {warnings.map((warning, index) => <Notice key={index} tone="warning">{warning}</Notice>)}
          {m.preview?.errors?.map((error, index) => <Notice key={index} tone="negative">{error}</Notice>)}
          {live ? <Box ref={nodeRef("typedConfirmation")} onMouseDown={() => setActive("typedConfirmation")}>
            <FieldLabel label={`Type ${confirmationSymbol} for LIVE`} active={active === "typedConfirmation"} />
            <TextField accessibleLabel={`Type ${confirmationSymbol} to confirm a LIVE order`} value={m.typedConfirmation ?? ""} onChange={(v) => onEdit("typedConfirmation", v)} focused={focused && active === "typedConfirmation"} active={active === "typedConfirmation"} width={formInner} onSubmit={() => setActive("confirm")} />
          </Box> : null}
          {m.error ? <Notice tone="negative">{m.error}</Notice> : null}
          <DialogActions wrap>{action("back", "Edit order")}{action("confirm", busy ? "Submitting..." : m.modifying ? "Confirm replacement" : live ? "Place LIVE order" : "Place simulation order", !typedMatches || blockingPreview || !m.connected || !m.tradingEnabled, true)}</DialogActions>
        </TicketSection> : null}
        {m.phase === "cancel-review" || m.phase === "cancelling" ? <TicketSection width={formWidth} title="Cancel this order?">
          <TicketOrderHeadline model={m} width={formInner} /><Notice>The order can still fill before the broker confirms cancellation.</Notice>
          <DialogActions wrap>{action("back", "Keep order")}{action("cancel", "Confirm cancellation", false, true)}</DialogActions>
        </TicketSection> : null}
        {m.phase === "result" ? <TicketSection width={formWidth} title={title}>
          <TicketOrderHeadline model={m} width={formInner} /><TicketStatus model={m} width={formInner} />
          {m.resultQuantities === "last-known" ? <Notice tone="warning">Last known quantities</Notice> : null}
          {!["PARTIALLY_FILLED", "FILLED"].includes(resultStatus) ? <TicketReceiptRow label="Filled" value={m.resultQuantities === "unconfirmed" || !Number.isFinite(m.result?.filled) ? "Not confirmed" : number(m.result?.filled)} width={formInner} /> : null}
          <TicketReceiptRow label="Remaining" value={m.resultQuantities === "unconfirmed" || !Number.isFinite(m.result?.remaining) ? "Not confirmed" : number(m.result?.remaining)} width={formInner} />
          <Text fg={c.textDim}>Estimates from order preview</Text>
          <TicketReceiptRow label="Preview cost" value={money(m.preview?.estimatedCost, currency)} width={formInner} />
          <TicketReceiptRow label="Fees" value={money(m.preview?.fees, currency)} width={formInner} />
          <TicketReceiptRow label="Commission" value={money(m.preview?.commission, m.preview?.commissionCurrency ?? currency)} width={formInner} />
          <TicketReceiptRow label="Buying power after" value={money(m.preview?.buyingPowerAfter, currency)} width={formInner} />
          {m.error && !["UNKNOWN", "REJECTED"].includes(resultStatus) ? <Notice tone="negative">{m.error}</Notice> : null}
          <DialogActions wrap>
            {resultStatus === "REJECTED" ? action("back", "Edit order") : null}
            {action("refresh", "Refresh status")}{action("orders", "Open orders")}
            {!["UNKNOWN", "REJECTED"].includes(resultStatus) ? action("new", "New order") : null}
          </DialogActions>
        </TicketSection> : null}
      </Box>
    </ScrollBox>
  </Box>;
}
