import type { BrokerAdapter, BrokerConnectionStatus } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { Quote } from "../../../types/financials";
import type { BrokerAccount, BrokerOrder, BrokerOrderPreview, BrokerOrderRequest, BrokerTradingCapabilities } from "../../../types/trading";

export interface BrokerTradingContext {
  adapter: BrokerAdapter;
  instance: BrokerInstanceConfig;
  accounts: BrokerAccount[];
  accountId?: string;
  /** Fresh signed quantity for this exact profile, account and requested contract. */
  availablePosition?: number;
  connection: BrokerConnectionStatus;
  /** Increment when a connection is replaced without an intermediate disconnected state. */
  connectionRevision?: string | number;
}

export interface BrokerTicketQuote {
  quote: Quote;
  brokerId: string;
  brokerInstanceId: string;
  sourceLabel: string;
  receivedAt: number;
  delayed: boolean;
  stale: boolean;
}

interface BrokerOrderReview {
  request: BrokerOrderRequest;
  preview: BrokerOrderPreview;
  warnings: string[];
  account: BrokerAccount;
  brokerName: string;
  createdAt: number;
  mode: "place" | "modify";
  requiresTypedConfirmation: boolean;
  confirmationText: string;
}

export interface BrokerTradingSnapshot {
  phase: "editing" | "previewing" | "review" | "submitting" | "result" | "cancel-review" | "cancelling";
  draft?: BrokerOrderRequest;
  quote?: BrokerTicketQuote;
  review?: BrokerOrderReview;
  result?: BrokerOrder;
  cancelOrder?: BrokerOrder;
  error?: string;
  loadingQuote?: boolean;
  modifying?: boolean;
}

interface ReviewGate {
  context: string;
  request: string;
  version: number;
  quoteRisk: string;
  order?: BrokerOrder;
}

const TERMINAL = new Set(["FILLED", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED", "SUPERSEDED"]);
const uncertainMessage = "Outcome unknown. Refresh orders and reconcile in your broker before trying again.";

function copy<T>(value: T): T { return structuredClone(value); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function positive(value: number | undefined): value is number { return value !== undefined && Number.isFinite(value) && value > 0; }
function errorMessage(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message : fallback; }

function tradingCapabilities(context: BrokerTradingContext, request?: BrokerOrderRequest): BrokerTradingCapabilities {
  return context.adapter.getTradingCapabilities?.(context.instance, request?.contract, request?.orderType) ?? {
    enabled: false, disabledReason: "This broker has not enabled the shared order ticket.", orderTypes: [], tif: [],
  };
}

/** All mutations pass through a consumed review or cancel confirmation. No method retries a mutation. */
export class BrokerTradingController {
  private snapshot: BrokerTradingSnapshot = freeze({ phase: "editing" });
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly staleQuoteMs: number;
  private readonly reviewTtlMs: number;
  private version = 0;
  private quoteVersion = 0;
  private gate?: ReviewGate;
  private modifyOrder?: BrokerOrder;
  private contextKey = "";
  private identityKey = "";
  private disposed = false;
  private mutationPending = false;

  constructor(private readonly options: { getContext: (request?: BrokerOrderRequest) => BrokerTradingContext; now?: () => number; staleQuoteMs?: number; reviewTtlMs?: number }) {
    this.now = options.now ?? Date.now;
    this.staleQuoteMs = options.staleQuoteMs ?? 60_000;
    this.reviewTtlMs = options.reviewTtlMs ?? 60_000;
    this.contextKey = this.key();
    this.identityKey = this.key(true);
  }

  getSnapshot = (): BrokerTradingSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private publish(update: Partial<BrokerTradingSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = freeze({ ...this.snapshot, ...update });
    for (const listener of this.listeners) listener();
  }

  private key(ignorePosition = false): string {
    const context = this.options.getContext(this.snapshot.draft);
    const account = context.accounts.find((item) => item.accountId === context.accountId);
    // This private comparison includes configuration changes but is never exposed in state or errors.
    return canonical({ broker: context.adapter.id, profile: context.instance.id, config: context.instance.config, enabled: context.instance.enabled,
      account: context.accountId, mode: account?.tradingMode ?? "unknown", name: account?.name,
      connection: context.connection.state, connectionMode: context.connection.mode, quoteData: context.connection.quoteData, revision: context.connectionRevision,
      capabilities: tradingCapabilities(context, this.snapshot.draft),
      availablePosition: !ignorePosition && this.snapshot.draft?.action === "SELL" ? context.availablePosition : undefined });
  }

  syncContext(): void {
    if (this.disposed) return;
    const next = this.key();
    if (next === this.contextKey) return;
    const nextIdentity = this.key(true);
    const onlyPositionChanged = nextIdentity === this.identityKey;
    this.identityKey = nextIdentity;
    this.contextKey = next;
    this.version++;
    this.quoteVersion++;
    this.gate = undefined;
    if (onlyPositionChanged) {
      if (!this.mutationPending && this.snapshot.phase !== "result") this.publish({ phase: "editing", review: undefined, loadingQuote: false, error: "The held position changed or became unavailable. Review the order again." });
      return;
    }
    if (!this.mutationPending) {
      this.modifyOrder = undefined;
      this.publish({ phase: "editing", modifying: false, review: undefined, result: undefined, cancelOrder: undefined, quote: undefined, loadingQuote: false, error: "Profile, account or connection changed. Review the order again." });
    }
  }

  private editable(): void {
    if (this.disposed) throw new Error("This order ticket is closed.");
    if (this.mutationPending) throw new Error("An order action is already pending.");
  }

  setDraft(request: BrokerOrderRequest): void {
    this.editable();
    if (this.modifyOrder && (canonical(request.contract) !== canonical(this.modifyOrder.contract) || request.action !== this.modifyOrder.action || request.accountId !== this.modifyOrder.accountId || request.orderType !== this.modifyOrder.orderType || request.tif !== this.modifyOrder.tif)) {
      throw new Error("A modification keeps the original account, instrument, side, type and time in force.");
    }
    const changedContract = canonical(request.contract) !== canonical(this.snapshot.draft?.contract);
    this.version++;
    this.gate = undefined;
    if (changedContract) { this.quoteVersion++; this.modifyOrder = undefined; }
    this.publish({ phase: "editing", draft: copy(request), modifying: !!this.modifyOrder, review: undefined, cancelOrder: undefined, result: undefined, error: undefined,
      ...(changedContract ? { quote: undefined, loadingQuote: false } : {}) });
    this.contextKey = this.key();
    this.identityKey = this.key(true);
  }

  private context(requireTrading = true, request = this.snapshot.draft): { context: BrokerTradingContext; account: BrokerAccount; capabilities: BrokerTradingCapabilities } {
    this.syncContext();
    if (this.disposed) throw new Error("This order ticket is closed.");
    const context = this.options.getContext(request);
    if (context.instance.enabled === false || context.connection.state !== "connected") throw new Error("Connect this broker profile before continuing.");
    const capabilities = tradingCapabilities(context, request);
    if (requireTrading && !capabilities.enabled) throw new Error(capabilities.disabledReason ?? "Trading is off. Enable it for this profile before continuing.");
    if (!context.accountId) throw new Error("Choose an account explicitly before continuing.");
    const account = context.accounts.find((item) => item.accountId === context.accountId);
    if (!account) throw new Error("The selected account is unavailable. Choose an account again.");
    return { context, account, capabilities };
  }

  private request(): BrokerOrderRequest {
    const { context, capabilities } = this.context();
    const request = this.snapshot.draft;
    if (!request) throw new Error("Enter an order first.");
    if (request.accountId !== context.accountId || (request.brokerInstanceId && request.brokerInstanceId !== context.instance.id)) throw new Error("The order must use the selected profile and account.");
    if (request.contract.brokerId !== context.adapter.id || (request.contract.brokerInstanceId && request.contract.brokerInstanceId !== context.instance.id)) throw new Error("Choose an instrument from this broker profile.");
    if (!request.contract.symbol.trim() || !["BUY", "SELL"].includes(request.action)) throw new Error("Choose an instrument and order side.");
    if (!capabilities.orderTypes.includes(request.orderType)) throw new Error("This broker does not support the selected order type.");
    if (!positive(request.quantity) || request.quantity < (capabilities.minQuantity ?? 0)) throw new Error("Enter a valid positive quantity.");
    if (request.action === "SELL" && !capabilities.shortSelling) {
      if (context.availablePosition === undefined || !Number.isFinite(context.availablePosition)) throw new Error("Refresh the position before selling. The held quantity is unavailable.");
      if (request.quantity > Math.max(0, context.availablePosition)) throw new Error("Sell quantity exceeds the held position. This broker has not enabled short selling.");
    }
    if (!capabilities.fractionalQuantity && !Number.isInteger(request.quantity)) throw new Error("This instrument requires a whole quantity.");
    if (positive(capabilities.quantityStep)) {
      const steps = request.quantity / capabilities.quantityStep;
      if (Math.abs(steps - Math.round(steps)) > 1e-8) throw new Error("Quantity does not match the broker's allowed increment.");
    }
    if (!capabilities.tif.includes(request.tif ?? "DAY")) throw new Error("This broker does not support the selected time in force.");
    if (request.outsideRth && (!capabilities.extendedHours || (capabilities.extendedHoursTif && !capabilities.extendedHoursTif.includes(request.tif ?? "DAY")))) throw new Error("Extended hours are unavailable for this order and time in force.");
    const limit = request.orderType === "LMT" || request.orderType === "STP LMT";
    const stop = request.orderType === "STP" || request.orderType === "STP LMT";
    for (const [needed, value, label] of [[limit, request.limitPrice, "limit"], [stop, request.stopPrice, "stop"]] as const) {
      if (needed && !positive(value)) throw new Error(`Enter a valid ${label} price.`);
      if (!needed && value !== undefined) throw new Error(`Remove the ${label} price for this order type.`);
      if (value !== undefined && capabilities.priceDecimals !== undefined && Number(value.toFixed(capabilities.priceDecimals)) !== value) throw new Error("Price precision exceeds the broker's limit.");
    }
    return copy(request);
  }

  private quoteRisk(quote: BrokerTicketQuote): string {
    return `${quote.delayed}:${this.quoteIsStale(quote.quote)}`;
  }

  private quoteIsStale(quote: Quote): boolean {
    return quote.stale === true || !Number.isFinite(quote.lastUpdated) || this.now() - quote.lastUpdated > this.staleQuoteMs;
  }

  async loadQuote(): Promise<BrokerTicketQuote> {
    const { context } = this.context(false);
    const draft = this.snapshot.draft;
    if (!draft || !context.adapter.getQuote) throw new Error("This broker cannot provide a quote for the ticket.");
    const fingerprint = this.key(), contractKey = canonical(draft.contract), version = ++this.quoteVersion;
    this.publish({ loadingQuote: true, error: undefined });
    try {
      const quote = await context.adapter.getQuote(draft.contract.symbol, context.instance, draft.contract.exchange, copy(draft.contract));
      if (this.disposed || version !== this.quoteVersion || fingerprint !== this.key() || contractKey !== canonical(this.snapshot.draft?.contract)) throw new Error("The quote belongs to an earlier ticket selection. Refresh it.");
      const allowedSymbols = [draft.contract.symbol, draft.contract.localSymbol].filter(Boolean).map((symbol) => symbol!.replace(/\s+/g, "").toUpperCase());
      if (!allowedSymbols.includes(quote.symbol.replace(/\s+/g, "").toUpperCase()) || !positive(quote.price)) throw new Error("The broker returned no usable quote for this instrument.");
      const delayed = quote.dataSource !== "live" || context.connection.quoteData !== "realtime";
      const result: BrokerTicketQuote = { quote: copy(quote), brokerId: context.adapter.id, brokerInstanceId: context.instance.id,
        sourceLabel: `${context.adapter.name}${delayed ? ", delayed" : ""}`, receivedAt: this.now(), delayed,
        stale: this.quoteIsStale(quote) };
      this.publish({ quote: result, loadingQuote: false });
      return copy(result);
    } catch (error) {
      if (version === this.quoteVersion) this.publish({ loadingQuote: false, error: errorMessage(error, "The broker quote is unavailable.") });
      throw error;
    }
  }

  applyPriceDefault(source: "bid" | "ask" | "mid" | "last", field: "limitPrice" | "stopPrice" = "limitPrice"): void {
    this.editable();
    this.syncContext();
    const draft = this.snapshot.draft, value = this.snapshot.quote;
    if (!draft || !value) throw new Error("Load this broker's quote before choosing a price.");
    const quote = value.quote;
    const price = source === "mid" ? positive(quote.bid) && positive(quote.ask) ? (quote.bid + quote.ask) / 2 : undefined : source === "last" ? quote.price : quote[source];
    if (!positive(price)) throw new Error("That broker quote price is unavailable.");
    const decimals = tradingCapabilities(this.options.getContext(draft), draft).priceDecimals;
    this.setDraft({ ...draft, [field]: decimals === undefined ? price : Number(price.toFixed(decimals)) });
  }

  async review(): Promise<void> {
    this.editable();
    const request = this.request();
    const { context, account, capabilities } = this.context();
    if (!context.adapter.previewOrder || !context.adapter.placeOrder) throw new Error("This broker does not support order preview and submission.");
    if (this.modifyOrder && (!context.adapter.modifyOrder || !capabilities.modify)) throw new Error("This broker does not support modifying this order.");
    const fingerprint = this.key(), version = ++this.version;
    this.gate = undefined;
    this.publish({ phase: "previewing", review: undefined, error: undefined });
    try {
      const quote = await this.loadQuote();
      if (version !== this.version || fingerprint !== this.key()) throw new Error("The order changed. Review it again.");
      const preview = await context.adapter.previewOrder(context.instance, copy(request));
      if (this.disposed || version !== this.version || fingerprint !== this.key() || canonical(request) !== canonical(this.snapshot.draft)) throw new Error("The order changed. Review it again.");
      quote.stale = this.quoteIsStale(quote.quote);
      const warnings = [...(preview.warnings ?? (preview.warningText ? [preview.warningText] : []))];
      if (quote.delayed) warnings.push("The broker quote is delayed.");
      if (quote.stale) warnings.push("The broker quote is stale. Prices may have changed.");
      if (request.orderType === "MKT" && (quote.delayed || quote.stale)) warnings.push("A market order can fill far from the displayed price.");
      if (quote.quote.marketState === "CLOSED") warnings.push("The broker reports the market is closed. The order may wait for another session.");
      const estimate = preview.estimatedCost ?? (request.limitPrice ?? quote.quote.price) * request.quantity * Number(request.contract.multiplier ?? "1");
      if (positive(account.buyingPower) && Number.isFinite(estimate) && Math.abs(estimate) > account.buyingPower * 0.25) warnings.push("This order exceeds 25% of the account's buying power.");
      const result: BrokerOrderReview = { request, preview: copy(preview), warnings: [...new Set(warnings)], account: copy(account), brokerName: context.adapter.name,
        createdAt: this.now(), mode: this.modifyOrder ? "modify" : "place", requiresTypedConfirmation: account.tradingMode !== "simulation", confirmationText: request.contract.symbol.toUpperCase() };
      this.gate = { context: fingerprint, request: canonical(request), version, quoteRisk: this.quoteRisk(quote), order: this.modifyOrder ? copy(this.modifyOrder) : undefined };
      this.publish({ phase: "review", review: result, quote, error: preview.errors?.length ? "The broker preview has blocking errors." : undefined });
    } catch (error) {
      if (!this.disposed && version === this.version) this.publish({ phase: "editing", review: undefined, error: errorMessage(error, "The broker could not preview this order.") });
      throw error;
    }
  }

  async confirm(typedConfirmation?: string): Promise<void> {
    this.editable();
    const request = this.request(), review = this.snapshot.review, gate = this.gate;
    const { context } = this.context();
    if (this.snapshot.phase !== "review" || !review || !gate || gate.version !== this.version || gate.context !== this.key() || gate.request !== canonical(request)) throw new Error("Review the current order before submitting.");
    if (review.preview.errors?.length) throw new Error("Resolve the broker preview errors before submitting.");
    if (this.now() - review.createdAt > this.reviewTtlMs || !this.snapshot.quote || gate.quoteRisk !== this.quoteRisk(this.snapshot.quote)) {
      this.gate = undefined;
      this.publish({ phase: "editing", review: undefined, error: "The review expired or the quote became stale. Review again." });
      throw new Error("The review expired or the quote became stale. Review again.");
    }
    if (review.requiresTypedConfirmation && typedConfirmation?.trim().toUpperCase() !== review.confirmationText) throw new Error(`Type ${review.confirmationText} to confirm this LIVE order.`);
    this.gate = undefined;
    this.version++;
    this.mutationPending = true;
    this.publish({ phase: "submitting", error: undefined });
    try {
      const result = gate.order ? await context.adapter.modifyOrder!(context.instance, gate.order.orderId, copy(request)) : await context.adapter.placeOrder!(context.instance, copy(request));
      if (!Number.isSafeInteger(result.orderId) || result.orderId <= 0 || (result.accountId && result.accountId !== request.accountId) || (result.brokerInstanceId && result.brokerInstanceId !== context.instance.id) || result.contract.brokerId !== context.adapter.id) throw new Error("The broker's order acknowledgement could not be verified.");
      this.publish({ phase: "result", result: copy(result), review: undefined });
    } catch {
      this.publish({ phase: "result", review: undefined, result: this.unknown(request, gate.order), error: uncertainMessage });
    } finally { this.mutationPending = false; }
  }

  beginModify(order: BrokerOrder): void {
    this.editable();
    const request = this.orderRequest(order);
    const { context, capabilities } = this.context(true, request);
    this.checkOrder(order, context);
    if (!capabilities.modify || !context.adapter.modifyOrder) throw new Error("This broker does not support modifying this order.");
    if (!["MKT", "LMT", "STP", "STP LMT"].includes(order.orderType)) throw new Error("This order type cannot be modified in the shared ticket.");
    this.modifyOrder = undefined;
    this.setDraft({ ...request, brokerInstanceId: context.instance.id });
    this.modifyOrder = copy(order);
    this.publish({ modifying: true });
  }

  private checkOrder(order: BrokerOrder, context: BrokerTradingContext): void {
    if (order.accountId !== context.accountId || (order.brokerInstanceId && order.brokerInstanceId !== context.instance.id) || order.contract.brokerId !== context.adapter.id) throw new Error("Select the order's original broker profile and account.");
    if (TERMINAL.has(order.status.toUpperCase()) || ["UNKNOWN", "PENDING_CANCEL", "PENDING_REPLACE"].includes(order.status.toUpperCase())) throw new Error("Refresh and reconcile this order before changing it.");
  }

  private orderRequest(order: BrokerOrder): BrokerOrderRequest {
    return { brokerInstanceId: order.brokerInstanceId, accountId: order.accountId, contract: copy(order.contract), action: order.action,
      orderType: order.orderType as BrokerOrderRequest["orderType"], quantity: order.quantity, limitPrice: order.limitPrice, stopPrice: order.stopPrice, tif: order.tif };
  }

  requestCancel(order: BrokerOrder): void {
    this.editable();
    const { context, capabilities } = this.context(true, this.orderRequest(order));
    this.checkOrder(order, context);
    if (!capabilities.cancel || !context.adapter.cancelOrder) throw new Error("This broker does not support cancelling this order.");
    this.version++;
    this.gate = { context: this.key(), request: canonical(order), version: this.version, quoteRisk: "" };
    this.publish({ phase: "cancel-review", cancelOrder: copy(order), review: undefined, error: undefined });
  }

  async confirmCancel(confirmed: boolean): Promise<void> {
    this.editable();
    if (!confirmed) { this.reset(); return; }
    const order = this.snapshot.cancelOrder, gate = this.gate;
    const { context, capabilities } = this.context(true, order ? this.orderRequest(order) : undefined);
    if (!capabilities.cancel || !context.adapter.cancelOrder || this.snapshot.phase !== "cancel-review" || !order || !gate || gate.context !== this.key() || gate.version !== this.version || gate.request !== canonical(order)) throw new Error("Confirm cancellation of the current order first.");
    this.checkOrder(order, context);
    this.gate = undefined;
    this.version++;
    this.mutationPending = true;
    this.publish({ phase: "cancelling", error: undefined });
    try {
      await context.adapter.cancelOrder(context.instance, order.orderId);
      this.publish({ phase: "result", cancelOrder: undefined, result: { ...copy(order), status: "PENDING_CANCEL", updatedAt: this.now() } });
    } catch {
      this.publish({ phase: "result", cancelOrder: undefined, result: { ...copy(order), status: "UNKNOWN", updatedAt: this.now() }, error: uncertainMessage });
    } finally { this.mutationPending = false; }
  }

  private unknown(request: BrokerOrderRequest, original?: BrokerOrder): BrokerOrder {
    return { ...original, orderId: original?.orderId ?? 0, brokerInstanceId: request.brokerInstanceId, accountId: request.accountId, contract: copy(request.contract),
      status: "UNKNOWN", action: request.action, orderType: request.orderType, quantity: request.quantity, filled: original?.filled ?? 0,
      remaining: original?.remaining ?? request.quantity, limitPrice: request.limitPrice, stopPrice: request.stopPrice, tif: request.tif, updatedAt: this.now() };
  }

  async refreshResult(): Promise<void> {
    const result = this.snapshot.result;
    if (!result) return;
    const { context } = this.context(false);
    if (!context.adapter.listOpenOrders) throw new Error("Refresh this order in your broker.");
    const fingerprint = this.key();
    const orders = await context.adapter.listOpenOrders(context.instance);
    if (this.disposed || fingerprint !== this.key() || this.snapshot.result !== result) return;
    const current = orders.find((order) => order.accountId === result.accountId && (result.brokerOrderId ? order.brokerOrderId === result.brokerOrderId : result.orderId !== 0 && order.orderId === result.orderId));
    if (current) this.publish({ result: copy(current), error: current.status === "UNKNOWN" ? uncertainMessage : undefined });
    // Absence from open orders does not prove a fill, rejection or cancellation.
  }

  reset(): void {
    this.editable();
    this.version++;
    this.gate = undefined;
    this.modifyOrder = undefined;
    this.publish({ phase: "editing", modifying: false, review: undefined, result: undefined, cancelOrder: undefined, error: undefined });
  }

  dispose(): void { this.disposed = true; this.version++; this.quoteVersion++; this.gate = undefined; this.listeners.clear(); }
}
