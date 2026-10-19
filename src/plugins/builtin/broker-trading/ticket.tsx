import { wholeNumberStep } from "../../../components/ui/number-step";
import { FigureText } from "../../../components/ui/figure";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Checkbox, FieldLabel, Icon, IconButton, Notice, NumberField, SegmentedControl, SelectButton, TextField, useFieldRing, usePaneFooter, usePaneMenuItems, type PaneHint, type SelectControl } from "../../../components";
import { useShortcut } from "../../../react/input";
import { afterLayout, revealInScrollBox } from "../../../components/ui/reveal-in-scroll-box";
import { useThemeColors } from "../../../theme/theme-context";
import type { Quote } from "../../../types/financials";
import type { BrokerAccount, BrokerOrder, BrokerOrderPreview, BrokerOrderRequest, BrokerTradingCapabilities } from "../../../types/trading";
import { Box, ScrollBox, Text, TextAttributes, useUiCapabilities, type BoxRenderable, type ScrollBoxRenderable } from "../../../ui";
import { useDialogState } from "../../../ui/dialog";
import { BrokerAccountPicker, type BrokerAccountChoice } from "./account-picker";
import { TicketLegs, TicketSection, TicketOrderHeadline, TicketOrderSummary, TicketReceiptRow, TicketStatus, ticketMoney as money, ticketNumber as number, ticketTypeName as typeName } from "./ticket-parts";

export type TicketAction = "enable" | "review" | "submit" | "back" | "confirm" | "refresh" | "orders" | "new" | "cancel" | "all" | "quantity25" | "quantity50" | "priceBid" | "priceMid" | "priceAsk" | "priceLast";
export type TicketField = "action" | "orderType" | "quantity" | "limitPrice" | "stopPrice" | "tif" | "outsideRth" | "typedConfirmation" | "confirmOrders";
export interface TicketViewModel {
  brokerName: string; symbol: string; accounts: BrokerAccount[]; accountId?: string;
  accountChoices?: readonly BrokerAccountChoice[]; accountChoiceValue?: string;
  quote?: Quote; quoteData?: "realtime" | "delayed";
  /** A spread's legs' quotes, in leg order. `quote` is then the spread's own. */
  legQuotes?: Quote[];
  phase: "enable" | "editing" | "previewing" | "review" | "submitting" | "result" | "cancel-review" | "cancelling";
  draft?: BrokerOrderRequest; preview?: BrokerOrderPreview; warnings: string[]; result?: BrokerOrder; error?: string;
  resultQuantities?: "confirmed" | "unconfirmed" | "last-known";
  position?: number; avgCost?: number; positionPnl?: number; accountType?: string;
  tradingEnabled: boolean; typedConfirmation?: string; synthetic?: boolean; connected: boolean;
  /** The profile is reconnecting: it keeps its accounts and says so instead of "disconnected". */
  reconnecting?: boolean;
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
  /** Terminal content measurement; the DOM uses intrinsic flex layout. */
  onContentHeight?(height: number): void;
}
export function ticketQuoteAge(quote: Quote | undefined, now = Date.now()): string {
  const at = quote?.lastTradeTime ?? quote?.lastUpdated;
  if (!at || at > now) return "Age unknown";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  return seconds < 60 ? `${seconds}s old` : seconds < 3600 ? `${Math.floor(seconds / 60)}m old` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m old`;
}
/** "+1.20 (+0.36%)", or nothing for a quote without a change of its own, such as a spread's. */
function quoteChange(quote: Quote | undefined): string {
  if (!quote || !Number.isFinite(quote.change)) return "";
  const signed = (value: number) => `${value >= 0 ? "+" : ""}${number(value)}`;
  return `${signed(quote.change)} (${signed(quote.changePercent)}%)`;
}
const stateName: Record<string, string> = {
  NEW: "Working", WORKING: "Working", SUBMITTED: "Submitted", PENDING_NEW: "Submitted", PARTIALLY_FILLED: "Partially filled", FILLED: "Filled",
  REJECTED: "Rejected", PENDING_CANCEL: "Pending cancel", CANCELED: "Cancelled", CANCELLED: "Cancelled", UNKNOWN: "Outcome unknown",
};
const tifName: Record<string, string> = { DAY: "Day", GTC: "Good til cancelled", IOC: "Immediate or cancel", FOK: "Fill or kill", EXTENDED_HOURS: "Extended hours", AT_THE_OPENING: "At the opening", AT_THE_CLOSE: "At the close" };
/** Beside the chart, the TIF button shows these. */
const tifShortName: Record<string, string> = { DAY: "Day", GTC: "GTC", IOC: "IOC", FOK: "FOK", EXTENDED_HOURS: "Extended", AT_THE_OPENING: "At open", AT_THE_CLOSE: "At close" };

/**
 * The wheel, arrow and +/- step for a price when the broker declares no tick:
 * a cent, or a hundredth of a cent under a dollar, never finer than the
 * decimals the broker accepts. Five accepted decimals are not a $0.00001 tick,
 * and stepping by one moved a $343 limit by nothing anyone could see.
 */
export function ticketEditingPriceStep(price: number | undefined, decimals?: number): number {
  const step = price !== undefined && Number.isFinite(price) && price > 0 && price < 1 ? 0.0001 : 0.01;
  const finest = decimals !== undefined && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? 10 ** -decimals : 0;
  return Math.max(step, finest);
}

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
  return <NumberField {...props} variant="well" value={raw} focused={focused} onChange={(next) => {
    if (next === rawRef.current) return;
    rawRef.current = next; setRaw(next); onChange(next);
  }} />;
}

/**
 * The docked quote: last price and change first, then bid in green and ask in
 * red with their sizes, as a broker's quote panel reads. A delayed quote shows
 * a clock whose tooltip names the source and its age.
 */
function DockedQuote({ quote, delayed, source, updated, price, width }: { quote?: Quote; delayed: boolean; source: string; updated: string; price(value: number | undefined): string; width: number }) {
  const c = useThemeColors();
  const native = useUiCapabilities().nativePaneChrome;
  const change = quoteChange(quote);
  const sized = (size: number | undefined) => size !== undefined && Number.isFinite(size) ? `× ${number(size)}` : "";
  // Sizes drop before bid and ask leave one line.
  const showSizes = `Bid ${price(quote?.bid)} ${sized(quote?.bidSize)}  Ask ${price(quote?.ask)} ${sized(quote?.askSize)}`.length <= width;
  const side = (label: string, value: number | undefined, size: number | undefined, color: string) => <Box flexDirection="row" gap={1} alignItems="baseline" flexShrink={0}>
    <Text fg={c.textDim}>{label}</Text>
    <Text fg={color} attributes={TextAttributes.BOLD} selectable>{price(value)}</Text>
    {showSizes && sized(size) ? <Text fg={c.textDim} selectable>{sized(size)}</Text> : null}
  </Box>;
  return <Box flexDirection="column" gap={native ? 0.2 : 0} data-gloom-selectable="true">
    <Box flexDirection="row" gap={1} alignItems={native ? "baseline" : "center"}>
      <FigureText>{quote?.price === undefined ? "--" : price(quote.price)}</FigureText>
      <Box flexGrow={1} minWidth={0}><FigureText part="sub" change={quote?.change}>{change}</FigureText></Box>
      {delayed ? <Box flexShrink={0} title={`${source} · ${updated}`}><Icon name="clock" color={c.warning} /></Box> : null}
    </Box>
    <Box flexDirection="row" gap={2}>
      {side("Bid", quote?.bid, quote?.bidSize, c.positive)}
      {side("Ask", quote?.ask, quote?.askSize, c.negative)}
    </Box>
  </Box>;
}

/** One ticket presentation, with the same review and focus gates on every renderer. */
export function BrokerTicketView({ model: m, width, height, focused, onEdit, onAction, onAccountChange, onCapture, docked = false, blocked = false, onClose, onContentHeight }: BrokerTicketViewProps) {
  const c = useThemeColors();
  const native = useUiCapabilities().nativePaneChrome;
  const dialogOpen = useDialogState((state) => state.isOpen);
  const scope = `broker-ticket:${useId()}`;
  const wide = width >= 110;
  const narrow = native && width < 70;
  const account = m.accounts.find((item) => item.accountId === m.accountId);
  const mode = account?.tradingMode ?? "unknown";
  const live = mode !== "simulation";
  const draft = m.draft;
  const sell = draft?.action === "SELL";
  const sideTone = sell ? "negative" : "positive";
  const currency = draft?.contract.currency ?? account?.currency ?? "USD";
  const strategy = !!draft?.legs?.length;
  // A credit spread's preview reports what it receives as a negative cost.
  const previewCredit = (m.preview?.estimatedCost ?? 0) < 0;
  const previewCost = m.preview?.estimatedCost === undefined ? undefined : Math.abs(m.preview.estimatedCost);
  const unit = strategy ? "spreads" : draft?.contract.secType === "OPT" ? "contracts" : "shares";
  const busy = blocked || ["previewing", "submitting", "cancelling"].includes(m.phase);
  const fast = mode === "simulation" && m.confirmOrders === false && !m.modifying;
  const fastSubmitting = m.phase === "submitting" && fast && !m.warnings.length && !m.preview?.errors?.length;
  const review = m.phase === "review" || m.phase === "submitting" && !fastSubmitting;
  const editing = m.phase === "editing" || m.phase === "previewing" || fastSubmitting;
  const showLimit = draft?.orderType === "LMT" || draft?.orderType === "STP LMT";
  const showStop = draft?.orderType === "STP" || draft?.orderType === "STP LMT";
  const extendedHours = m.capabilities?.extendedHours && (!m.capabilities.extendedHoursTif || m.capabilities.extendedHoursTif.includes(draft?.tif ?? "DAY"));
  const inner = Math.max(28, width - (docked ? 2 : native ? 6 : 2));
  const formWidth = wide ? Math.min(74, Math.floor((inner - 3) * 0.58)) : inner;
  const summaryWidth = inner - formWidth - 3;
  const rowGap = native ? 0.25 : 0;
  const labelWidth = docked ? 10 : native ? 11 : 14;
  const selectWidth = docked ? Math.max(14, formWidth - 11) : 22;
  const [active, setActive] = useState("account");
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const headerRef = useRef<BoxRenderable | null>(null);
  const bodyRef = useRef<BoxRenderable | null>(null);
  const reportContentHeight = () => {
    if (native || !docked || !headerRef.current?.height || !bodyRef.current?.height) return;
    onContentHeight?.(headerRef.current.height + bodyRef.current.height);
  };
  const reviewControlRef = useRef<BoxRenderable | null>(null);
  const confirmControlRef = useRef<BoxRenderable | null>(null);
  const accountControl = useRef<SelectControl>(null);
  const tifControl = useRef<SelectControl>(null);
  const orderTypeControl = useRef<SelectControl>(null);
  const resultStatus = m.result?.status.toUpperCase() ?? "UNKNOWN";
  // Tab order of the focusable controls in each phase.
  const keys = useMemo((): string[] => {
    if (m.phase === "enable") return ["enable", "back"];
    if (editing) return [
      "account", "action", "orderType", "quantity", "quantity25", "quantity50", "all",
      ...(showLimit ? ["limitPrice", "priceBid", "priceMid", "priceAsk", "priceLast"] : []),
      ...(showStop ? ["stopPrice"] : []),
      "tif",
      ...(extendedHours ? ["outsideRth"] : []),
      ...(mode === "simulation" && !m.modifying ? ["confirmOrders"] : []),
      m.tradingEnabled ? "review" : "enable",
    ];
    if (review) return ["back", ...(live ? ["typedConfirmation"] : []), "confirm"];
    if (m.phase === "cancel-review") return ["back", "cancel"];
    if (resultStatus === "REJECTED") return ["back", "refresh", "orders"];
    if (resultStatus === "FILLED") return ["new", "refresh", "orders"];
    if (resultStatus === "UNKNOWN") return ["refresh", "orders"];
    return ["refresh", "orders", "new"];
  }, [m.phase, editing, review, live, showLimit, showStop, extendedHours, resultStatus, m.tradingEnabled, mode, m.modifying]);
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
  // A review taller than the panel still shows its place button on arrival;
  // focus stays on Edit order, so Enter alone never places it.
  useEffect(() => {
    if (review) return afterLayout(() => revealInScrollBox(scrollRef.current, confirmControlRef.current));
  }, [review]);
  const confirmationSymbol = (draft?.contract.symbol ?? m.symbol).toUpperCase();
  const typedMatches = !live || m.typedConfirmation?.trim().toUpperCase() === confirmationSymbol;
  const holdingBlocked = sell && !strategy && !m.capabilities?.shortSelling && (m.position === undefined || (draft?.quantity ?? 0) > Math.max(0, m.position));
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
  // A spread sizes by hand: its cost and holdings are per leg.
  const quickDisabled = (key: TicketAction) => strategy && ["all", "quantity25", "quantity50", "priceLast"].includes(key) ? true : key === "priceBid" ? !validPrice(m.quote?.bid) : key === "priceAsk" ? !validPrice(m.quote?.ask)
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
    ...(showLimit || showStop ? ([["8", "Bid", "priceBid"], ["9", "Mid", "priceMid"], ["0", "Ask", "priceAsk"], ...(strategy ? [] : [["p", "Last", "priceLast"]] as const)] as const)
      .map(([key, label, action]) => actionShortcut(key, label, action, quickDisabled(action))) : []),
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
    // The shortcut registry lets plain letters repeat, for typing and stepping. A ticket action acts once per
    // press, so a held key never steps past a consent, a confirmation or a result.
    if (!shortcut.disabled && !event.repeat) shortcut.onPress?.();
  }, { enabled: focused && !dialogOpen, phase: "before", scope, allowEditable: true });
  // The full keyboard map remains available without filling the status bar.
  const footerKeys = editing ? ["r", "o"] : m.phase === "result" ? ["r", "o", resultStatus === "REJECTED" ? "e" : "n"] : ["e"];
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
    { id: "ticket-back", label: textActive ? "Leave field" : review || m.phase === "cancel-review" ? "Edit order" : "Close trade panel", accelerator: "Esc",
      onSelect: () => { if (busy) return; if (editing && textActive) setActive("account"); else if (review || m.phase === "cancel-review" || m.phase === "enable") onAction("back"); else onClose?.(); } },
  ], [m, busy, active, textActive, canConfirm, canReview, onClose]);
  // The terminal marks the focused control with ">"; inline result links use their short names.
  const marker = (key: string) => focused && active === key ? "> " : "";
  const action = (key: TicketAction, label: string, disabled = false, primary = false, tone: "positive" | "negative" | "neutral" | "warning" = sideTone, inline = false) => {
    const shortLabel = ({ refresh: "Refresh", orders: "Orders", new: "New" } as Partial<Record<TicketAction, string>>)[key] ?? label;
    const displayLabel = native ? undefined : inline ? `${marker(key)}${shortLabel}` : marker(key) ? `> ${label}` : undefined;
    const ref = (node: BoxRenderable | null) => {
      nodeRef(key)(node);
      if (key === "review") reviewControlRef.current = node;
      if (key === "confirm") confirmControlRef.current = node;
    };
    return <Box ref={ref} onMouseDown={() => setActive(key)} flexShrink={0}>
      <Button label={label} displayLabel={displayLabel} variant={inline ? "plain" : primary ? "primary" : "quiet"} flush={inline} compact={inline}
        tone={primary ? tone : undefined} height={native && primary ? 2 : 1} active={focused && active === key} disabled={disabled || busy}
        width={primary ? Math.max(16, formWidth) : undefined} onPress={() => { setActive(key); onAction(key === "review" ? "submit" : key); }} />
    </Box>;
  };
  const quick = (key: TicketAction, label: string, disabled = false) => <Box ref={nodeRef(key)} key={key}>
    <Button label={label} displayLabel={!native && marker(key) ? `> ${label}` : undefined} variant="quiet" compact active={active === key && focused}
      disabled={disabled || busy} onPress={() => { setActive(key); onAction(key); }} />
  </Box>;
  const numeric = (key: TicketField, label: string, value: number | undefined, suffix: string, picks?: ReactNode) => {
    const inlinePicks = !!picks && formWidth >= 60;
    const quantity = key === "quantity";
    const reportedStep = m.capabilities?.quantityStep ?? 1;
    const quantityStep = m.capabilities?.fractionalQuantity ? reportedStep : wholeNumberStep(reportedStep) ?? NaN;
    // Decimal precision is not a declared exchange tick. The fallback is an editing convenience only.
    const priceStep = m.capabilities?.priceStep ?? ticketEditingPriceStep(value ?? m.quote?.price, m.capabilities?.priceDecimals);
    const step = quantity ? quantityStep : priceStep;
    return <Box flexDirection="column" gap={0}>
    <Box flexDirection="row" alignItems="center" gap={1}>
    <Box ref={nodeRef(key)} onMouseDown={() => { if (!busy) setActive(key); }} flexDirection="row" alignItems="center" gap={1} flexGrow={1}>
      <FieldLabel label={label} width={labelWidth} active={active === key} />
      <Box flexGrow={1}><TicketNumberInput accessibleLabel={key === "limitPrice" ? "Limit price" : key === "stopPrice" ? "Stop price" : label} value={value}
        width={Math.max(14, formWidth - (docked ? 11 : native ? 21 : 24) - (inlinePicks ? 20 : 0))} focused={focused && active === key && !busy} active={active === key} disabled={busy}
        step={step} min={quantity ? Math.max(step, m.capabilities?.minQuantity ?? step) : step} max={quantity && sell && !m.capabilities?.shortSelling ? Math.max(0, m.position ?? 0) : undefined}
        onChange={(text) => { if (!busy) onEdit(key, text); }} onSubmit={() => setActive(m.tradingEnabled ? "review" : "enable")} /></Box>
      {!docked ? <Text fg={c.textDim}>{suffix}</Text> : null}
    </Box>
    {inlinePicks ? <Box flexDirection="row" gap={1}>{picks}</Box> : null}
    </Box>
    {picks && !inlinePicks ? <Box flexDirection="row" justifyContent="flex-end" gap={1} paddingRight={docked ? 0 : 9}>{picks}</Box> : null}
    </Box>;
  };
  const quotePrice = (value: number | undefined) => value === undefined ? "Unavailable" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, Math.min(8, m.capabilities?.priceDecimals ?? 4)) });
  const sourceAt = m.quote?.lastTradeTime ?? m.quote?.lastUpdated;
  const updated = sourceAt && Number.isFinite(sourceAt) ? `${new Date(sourceAt).toISOString().slice(11, 19)} UTC` : "unknown";
  const delayed = m.quoteData !== "realtime" || m.quote?.dataSource !== "live";
  const source = `${m.brokerName}, ${delayed ? "delayed" : "real-time"} ${ticketQuoteAge(m.quote, m.now).replace(" old", "")}`;
  const accountPicker = (pickerWidth: number) => <BrokerAccountPicker
    accounts={m.accountChoices ?? m.accounts.map((a) => ({ value: a.accountId, label: a.name, tradingMode: a.tradingMode }))}
    value={m.accountChoiceValue ?? m.accountId} onChange={onAccountChange} disabled={!editing || busy || m.modifying}
    active={active === "account" && focused} controlRef={accountControl} width={pickerWidth} showMode />;
  const bookSide = (label: string, size: number | undefined, value: number | undefined, color: string) => <Box flexDirection="column" paddingX={1}
    border={["bottom"]} borderColor={color} style={native ? { borderBottom: `2px solid ${color}` } : undefined}>
    <Text fg={c.textDim}>{`${label}${size !== undefined ? ` × ${number(size)}` : ""}`}</Text>
    <Text fg={color} attributes={TextAttributes.BOLD}>{quotePrice(value)}</Text>
  </Box>;
  const resultQuantity = (value: number | undefined) => m.resultQuantities === "unconfirmed" || !Number.isFinite(value) ? "Not confirmed" : number(value);
  const title = stateName[resultStatus] ?? m.result?.status ?? "Outcome unknown";
  // A spread's limit is its net debit or credit.
  const limitLabel = strategy ? docked ? sell ? "Credit" : "Debit" : sell ? "Net credit" : "Net debit" : docked ? "Limit" : "Limit price";
  const warnings = [...new Set(m.warnings)];
  if (warnings.includes("The broker quote is delayed.") && warnings.includes("The broker quote is stale. Prices may have changed.")) {
    warnings.splice(warnings.indexOf("The broker quote is delayed."), 1);
    warnings[ warnings.indexOf("The broker quote is stale. Prices may have changed.") ] = "Delayed, stale broker quote. Execution prices may differ.";
  }
  return <Box flexDirection="column" flexGrow={docked ? 0 : 1} flexShrink={1} minHeight={0} height={docked ? undefined : height} maxHeight={height}>
    {docked ? <Box ref={headerRef} onSizeChange={native ? undefined : reportContentHeight} flexDirection="column" paddingX={1} paddingTop={native ? 0.4 : 0} gap={native ? 0.4 : 0} flexShrink={0}>
      <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
        <Box ref={nodeRef("account")} flexShrink={1} minWidth={0}>{accountPicker(width - (onClose ? 6 : 2))}</Box>
        {onClose ? <IconButton icon="close" label="Close trade panel" shortcut="Esc" onPress={onClose} /> : null}
      </Box>
      <DockedQuote quote={m.quote} delayed={delayed} source={source} updated={updated} price={quotePrice} width={width - 2} />
    </Box> : <Box flexShrink={0}>
      <Box flexDirection="column" data-gloom-selectable="true" paddingX={native ? 3 : 1} paddingY={native ? wide ? 1 : 0.5 : 0} gap={native ? wide ? 0.65 : 0.2 : 0} >
        <Box flexDirection={narrow ? "column" : "row"} justifyContent="space-between" alignItems={narrow ? "flex-start" : "center"} gap={narrow ? 0.4 : 1}>
          <Box flexDirection="row" alignItems="center" gap={1} flexGrow={1} minWidth={0}>
            <Text fg={c.textBright} attributes={TextAttributes.BOLD}>{m.symbol}</Text>
            <Text fg={c.textDim} truncate>{m.quote?.name && m.quote.name !== m.symbol ? m.quote.name : ""}</Text>
            {m.synthetic && narrow ? <Badge label="SYNTHETIC" /> : null}
          </Box>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Box ref={nodeRef("account")} onMouseDown={() => { if (editing) setActive("account"); }} flexShrink={0}>{accountPicker(Math.min(42, width - 6))}</Box>
            {m.synthetic && wide ? <Badge label="SYNTHETIC" /> : null}
          </Box>
        </Box>
        <Box flexDirection={narrow ? "column" : "row"} alignItems={narrow ? "flex-start" : "center"} gap={narrow ? 0.5 : 2}>
          <Box flexDirection="row" alignItems="center" gap={2}>
            <FigureText>{money(m.quote?.price, currency)}</FigureText>
            <FigureText part="sub" change={m.quote?.change}>{quoteChange(m.quote)}</FigureText>
          </Box>
          <Box flexDirection="row" gap={1}>
            {bookSide("Bid", m.quote?.bidSize, m.quote?.bid, c.positive)}
            {bookSide("Ask", m.quote?.askSize, m.quote?.ask, c.negative)}
          </Box>
        </Box>
        <Box flexDirection="row" flexWrap={native ? "wrap" : "nowrap"} alignItems="center" gap={1}>
          <Text fg={delayed ? c.warning : c.textDim}>{source}</Text>
          <Text fg={c.textDim}>{`${updated}${m.synthetic && !wide && !narrow ? " · SYNTHETIC" : ""}`}</Text>
        </Box>
      </Box>
    </Box>}
    <ScrollBox ref={scrollRef} flexGrow={docked ? 0 : 1} flexShrink={1} scrollY>
      <Box ref={bodyRef} onSizeChange={native ? undefined : reportContentHeight} flexShrink={0} flexDirection="column" paddingX={docked ? 1 : native ? 3 : 1} paddingY={native ? wide ? 1 : 0.4 : 0} gap={native ? wide ? 1 : 0.3 : 0}>
        {!docked ? <Box flexDirection="row" gap={1} flexWrap={native ? "wrap" : "nowrap"}>
          {/* A spread's positions are its legs', which the form lists. */}
          {strategy ? null : <Text fg={c.textDim}>{`Position ${m.position === undefined ? "unknown" : `${number(m.position)} ${unit === "shares" ? "sh" : "ct"}`}${m.avgCost === undefined ? "" : ` @ ${money(m.avgCost, currency)}`}`}</Text>}
          {m.positionPnl !== undefined ? <Text fg={m.positionPnl >= 0 ? c.positive : c.negative}>{`P&L ${money(m.positionPnl, currency)}`}</Text> : null}
          <Text fg={c.textDim}>{`Buying power ${money(account?.buyingPower, currency)}`}</Text>
          {m.accountType ? <Text fg={c.textDim}>{m.accountType}</Text> : null}
        </Box> : null}
        {editing && draft ? <Box flexDirection={wide ? "row" : "column"} gap={wide ? 3 : 0} alignItems="flex-start">
          <TicketSection width={formWidth} title={m.modifying ? "Modify order" : docked ? undefined : "Order details"}>
            <Box flexDirection="column" gap={rowGap}>
              {!m.connected ? m.reconnecting ? <Notice tone="muted">{`Reconnecting to ${m.brokerName}...`}</Notice> : <Notice variant="callout">Broker disconnected. Connect in Brokers.</Notice>
                : !m.tradingEnabled ? <Notice variant="callout">Trading is off for this profile.</Notice> : null}
              <Box ref={nodeRef("action")} flexDirection="row" onMouseDown={() => setActive("action")}>
                {!native ? <FieldLabel label="" width={2} active={focused && active === "action"} /> : null}
                <Box flexGrow={1}><SegmentedControl variant="flat" accessibleLabel="Order side" value={draft.action} size="large" width="100%"
                  options={[{ value: "BUY", label: "Buy", tone: "positive", disabled: busy || m.modifying }, { value: "SELL", label: "Sell", tone: "negative", disabled: busy || m.modifying }]}
                  focused={focused && active === "action"} onChange={(v) => onEdit("action", v)} shortcutScope={scope} /></Box>
              </Box>
              <Box ref={nodeRef("orderType")} flexDirection="row" gap={1} alignItems="center" onMouseDown={() => { if (!busy) setActive("orderType"); }}>
                <FieldLabel label={docked ? "Type" : "Order type"} width={labelWidth} active={active === "orderType"} />
                <SelectButton label="Order type" showLabel={false} variant="well" width={selectWidth} value={draft.orderType}
                  options={(m.capabilities?.orderTypes ?? ["LMT"]).map((t) => ({ value: t, label: typeName[t] ?? t }))} disabled={busy || m.modifying}
                  emphasized={focused && active === "orderType"} controlRef={orderTypeControl} onFocus={() => setActive("orderType")} onChange={(v) => onEdit("orderType", v)} />
              </Box>
              {strategy ? <TicketLegs model={m} width={formWidth} inset /> : null}
              {numeric("quantity", strategy && docked ? "Spreads" : "Quantity", draft.quantity, unit, strategy ? undefined : <>
                {quick("quantity25", "25%", sell && m.position === undefined)}
                {quick("quantity50", "50%", sell && m.position === undefined)}
                {quick("all", sell ? `Max ${number(m.position)}` : "Max", sell && !(m.position && m.position > 0))}
              </>)}
              {showLimit ? numeric("limitPrice", limitLabel, draft.limitPrice, currency, <>
                {quick("priceBid", "Bid", !(m.quote?.bid! > 0))}
                {quick("priceMid", "Mid", !(m.quote?.bid! > 0) || !(m.quote?.ask! > 0))}
                {quick("priceAsk", "Ask", !(m.quote?.ask! > 0))}
                {strategy ? null : quick("priceLast", "Last", !m.quote?.price)}
              </>) : null}
              {showStop ? numeric("stopPrice", docked ? "Stop" : "Stop price", draft.stopPrice, currency) : null}
              <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap={docked ? rowGap : 1}>
                <Box ref={nodeRef("tif")} flexDirection="row" alignItems="center" gap={1} onMouseDown={() => setActive("tif")}>
                  <FieldLabel label="TIF" width={labelWidth} active={active === "tif"} />
                  <SelectButton label="Time in force" title="Time in force" showLabel={false} variant="well" width={selectWidth} value={draft.tif ?? "DAY"}
                    options={(m.capabilities?.tif ?? ["DAY"]).map((v) => ({ value: v, label: tifName[v] ?? v, short: docked ? tifShortName[v] : undefined }))} disabled={busy || m.modifying}
                    emphasized={focused && active === "tif"} controlRef={tifControl} onFocus={() => setActive("tif")} onChange={(v) => onEdit("tif", v)} />
                </Box>
                {extendedHours ? <Box ref={nodeRef("outsideRth")}><Checkbox label="Outside RTH" checked={draft.outsideRth ?? false} disabled={busy || m.modifying}
                  active={focused && active === "outsideRth"} onChange={(v) => { setActive("outsideRth"); onEdit("outsideRth", v); }} /></Box> : null}
              </Box>
              {holdingBlocked ? <Notice tone="negative">{m.position === undefined ? "Refresh holdings before selling." : `You hold ${number(m.position)} ${unit}. Short selling is unavailable.`}</Notice> : null}
              {m.error ? <Notice variant="callout" tone="negative">{m.error}</Notice> : null}
              {mode === "simulation" && !m.modifying ? <Box ref={nodeRef("confirmOrders")} flexDirection="column" gap={native ? 0.25 : 0}>
                <Checkbox label="Confirm orders" checked={!fast} disabled={busy} active={focused && active === "confirmOrders"} onChange={(value) => { setActive("confirmOrders"); onEdit("confirmOrders", value); }} />
                {fast ? <Text fg={c.warning}>SIM one-click · preview required</Text> : null}
              </Box> : null}
              {docked ? <Box flexDirection="column">
                <TicketReceiptRow label={strategy && sell ? "Est. credit" : "Est. cost"} width={formWidth}
                  value={money((draft.limitPrice ?? draft.stopPrice ?? m.quote?.price ?? NaN) * draft.quantity * Number(draft.contract.multiplier ?? 1), currency)} />
                <TicketReceiptRow label="Buying power" value={money(account?.buyingPower, currency)} width={formWidth} />
              </Box> : null}
              <Box marginTop={native && !docked ? 0.5 : 0}>{m.tradingEnabled
                ? action("review", busy ? blocked ? "Order action pending..." : m.phase === "submitting" ? "Submitting..." : "Requesting preview..." : `${sell ? "Sell" : "Buy"} ${number(draft.quantity)} ${m.symbol}`, !canReview, true)
                : action("enable", "Enable trading", !m.connected, true, "neutral")}</Box>
            </Box>
          </TicketSection>
        </Box> : null}
        {m.phase === "enable" ? <Box flexDirection={wide ? "row" : "column"} gap={3}><TicketSection width={formWidth} title="Enable trading">
          <FigureText>Review first. Confirm once.</FigureText>
          <Notice variant="callout" tone="warning">Orders can commit real money.</Notice>
          <Text fg={c.text} wrapText>Start with a simulation account. Every order gets its own broker preview and review.</Text>
          <Text fg={c.textDim} wrapText>LIVE orders also require a typed confirmation. Turn trading off at any time in Brokers.</Text>
          <Box marginTop={1} gap={1} flexDirection="column">{action("enable", "Enable trading", false, true, "neutral")}{action("back", "Keep read only")}</Box>
        </TicketSection>{wide ? <TicketOrderSummary model={m} width={summaryWidth} /> : null}</Box> : null}
        {review ? <Box flexDirection={wide ? "row" : "column"} gap={wide ? 3 : 0} alignItems="flex-start"><TicketSection width={formWidth} title={m.modifying ? "Review replacement" : "Review order"} selectable>
          <TicketOrderHeadline model={m} large />
          {strategy ? <TicketLegs model={m} width={formWidth} /> : null}
          <Text fg={c.textDim}>{[
            `${typeName[draft?.orderType ?? "LMT"]}${showLimit ? ` ${strategy ? sell ? "net credit" : "net debit" : "at"} ${money(draft?.limitPrice, currency)}` : ""}`,
            ...(showStop ? [`Stop ${money(draft?.stopPrice, currency)}`] : []),
            draft?.tif ?? "DAY",
          ].join(" · ")}</Text>
          <Box marginTop={native && wide ? 1 : 0} flexDirection="column" gap={native && wide ? 0.4 : 0}>
            <TicketReceiptRow label="Fees" value={money(m.preview?.fees, currency)} width={formWidth} />
            <TicketReceiptRow label="Commission" value={money(m.preview?.commission, m.preview?.commissionCurrency ?? currency)} width={formWidth} />
            {!wide ? <TicketOrderSummary model={m} width={formWidth} compact receipt /> : null}
          </Box>
          <Box flexDirection="row" justifyContent="space-between" alignItems={native ? "baseline" : "center"} paddingTop={native && wide ? 0.7 : 0}>
            <Text fg={c.textDim}>{previewCredit ? "Estimated credit" : "Estimated cost"}</Text>
            <FigureText>{money(previewCost, currency)}</FigureText>
          </Box>
          {/* Beside the chart, warnings are lines, so the place button fits without scrolling. */}
          {warnings.map((warning, index) => <Notice key={index} variant={docked ? undefined : "callout"} tone="warning">{warning}</Notice>)}
          {m.preview?.errors?.map((error, index) => <Notice key={index} variant={docked ? undefined : "callout"} tone="negative">{error}</Notice>)}
          {live ? <TicketSection width={formWidth}><Box ref={nodeRef("typedConfirmation")} onMouseDown={() => setActive("typedConfirmation")}>
            <FieldLabel label={`Type ${confirmationSymbol} to confirm a LIVE order`} active={active === "typedConfirmation"} />
            <TextField variant="well" accessibleLabel={`Type ${confirmationSymbol} to confirm a LIVE order`} value={m.typedConfirmation ?? ""} onChange={(v) => onEdit("typedConfirmation", v)}
              focused={focused && active === "typedConfirmation"} active={active === "typedConfirmation"} width={formWidth} onSubmit={() => setActive("confirm")} />
          </Box></TicketSection> : null}
          {m.error ? <Notice tone="negative">{m.error}</Notice> : null}
          <Box flexDirection="column" gap={native ? 0.5 : 0}>
            {action("back", "Edit order")}
            {action("confirm", busy ? "Submitting..." : m.modifying ? "Confirm replacement" : live ? "Place LIVE order" : "Place simulation order",
              !typedMatches || blockingPreview || !m.connected || !m.tradingEnabled, true, live ? "negative" : sideTone)}
          </Box>
        </TicketSection>{wide ? <TicketOrderSummary model={m} width={summaryWidth} receipt /> : null}</Box> : null}
        {m.phase === "cancel-review" || m.phase === "cancelling" ? <TicketSection width={formWidth} title="Cancel this order?">
          <TicketOrderHeadline model={m} large /><Notice variant="callout">The order can still fill before the broker confirms cancellation.</Notice>
          <Box flexDirection="column" gap={native ? 0.5 : 0}>{action("back", "Keep order")}{action("cancel", "Confirm cancellation", false, true, "negative")}</Box>
        </TicketSection> : null}
        {m.phase === "result" ? <Box flexDirection={wide ? "row" : "column"} gap={3}><TicketSection width={formWidth} title={title} selectable>
          <TicketOrderHeadline model={m} large />{strategy ? <TicketLegs model={m} width={formWidth} /> : null}<TicketStatus model={m} width={formWidth} />
          {m.resultQuantities === "last-known" ? <Text fg={c.warning}>Last known quantities</Text> : null}
          {!["PARTIALLY_FILLED", "FILLED"].includes(resultStatus) ? <TicketReceiptRow label="Filled" value={resultQuantity(m.result?.filled)} width={formWidth} /> : null}
          <TicketReceiptRow label="Remaining" value={resultQuantity(m.result?.remaining)} width={formWidth} />
          <Text fg={c.textDim}>Estimates from order preview</Text>
          <TicketReceiptRow label={previewCredit ? "Preview credit" : "Preview cost"} value={money(previewCost, currency)} width={formWidth} />
          <TicketReceiptRow label="Fees" value={money(m.preview?.fees, currency)} width={formWidth} />
          <TicketReceiptRow label="Commission" value={money(m.preview?.commission, m.preview?.commissionCurrency ?? currency)} width={formWidth} />
          <TicketReceiptRow label="Buying power after" value={money(m.preview?.buyingPowerAfter, currency)} width={formWidth} />
          {m.error && !["UNKNOWN", "REJECTED"].includes(resultStatus) ? <Notice variant="callout" tone="negative">{m.error}</Notice> : null}
          {["NEW", "WORKING", "SUBMITTED", "PENDING_NEW", "PARTIALLY_FILLED"].includes(resultStatus) ? <Box flexDirection="row" alignItems="center" gap={1}>
            {action("refresh", "Refresh status", false, false, "neutral", true)}<Text fg={c.textDim}>·</Text>
            {action("orders", "Open orders", false, false, "neutral", true)}<Text fg={c.textDim}>·</Text>
            {action("new", "New order", false, false, "neutral", true)}
          </Box> : <Box flexDirection="column" gap={native ? 0.5 : 0}>
            {resultStatus === "REJECTED" ? action("back", "Edit order", false, true, "neutral")
              : resultStatus === "FILLED" ? action("new", "New order", false, true)
              : action("refresh", "Refresh status", false, true, resultStatus === "UNKNOWN" ? "warning" : "neutral")}
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              {["REJECTED", "FILLED"].includes(resultStatus) ? action("refresh", "Refresh status") : null}
              {action("orders", "Open orders")}
              {!["UNKNOWN", "REJECTED", "FILLED"].includes(resultStatus) ? action("new", "New order") : null}
            </Box>
          </Box>}
        </TicketSection>{wide ? <TicketOrderSummary model={m} width={summaryWidth} /> : null}</Box> : null}
      </Box>
    </ScrollBox>
  </Box>;
}
