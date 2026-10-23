import { matchesNumberStep } from "../../../components/ui/number-step";
import type { BrokerAdapter, BrokerConnectionStatus } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { Quote } from "../../../types/financials";
import type { BrokerAccount, BrokerOrder, BrokerOrderPreview, BrokerOrderRequest, BrokerTradingCapabilities } from "../../../types/trading";
import { optionContractIdentity } from "../../../utils/options";
import { isStrategyOrder, strategyQuote } from "./strategy";
import { brokerOrderDone, brokerOrderStatus, orderEstimatePrice, ticketEditingPriceStep } from "./orders-data";

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
  /** A spread's own legs' quotes, in leg order; `quote` is the spread's. */
  legs?: Quote[];
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

/** What became of an order whose change or cancel the broker refused: one line, which the view shows once. */
export interface BrokerOrderOutcome {
  title: string;
  type: "info" | "error";
  /** The order as the broker now reports it, else as it was. */
  order: BrokerOrder;
}

export interface BrokerTradingSnapshot {
  phase: "editing" | "previewing" | "review" | "submitting" | "result" | "cancel-review" | "cancelling";
  draft?: BrokerOrderRequest;
  quote?: BrokerTicketQuote;
  review?: BrokerOrderReview;
  /** Read-only receipt of the consumed preview. Never authorizes another mutation. */
  receipt?: BrokerOrderReview;
  result?: BrokerOrder;
  /** Quantity provenance, separate from the broker status. A lost acknowledgement confirms nothing. */
  resultQuantities?: "confirmed" | "unconfirmed" | "last-known";
  cancelOrder?: BrokerOrder;
  error?: string;
  loadingQuote?: boolean;
  modifying?: boolean;
  /** Opt-in is ephemeral and scoped to the current SIM profile/account. */
  confirmOrders: boolean;
}

interface ReviewGate {
  context: string;
  request: string;
  version: number;
  quoteRisk: string;
  order?: BrokerOrder;
}

const TERMINAL = new Set(["FILLED", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED", "SUPERSEDED"]);
/** A streamed quote older than this is no longer being pushed: the ticket asks the broker instead. */
const STREAM_QUOTE_MAX_SILENCE_MS = 75_000;
/** A placement whose answer was lost: only the broker's open orders can say whether it went in. */
const uncertainPlacement = "Outcome unknown. Check open orders before placing it again.";
/** A change or cancel whose answer was lost: the views ask the broker until it says. */
const uncertainChange = "Outcome unknown. Checking with the broker.";
/** The broker's own words come first: they say more than "outcome unknown". */
const uncertainAfter = (error: unknown) => error instanceof Error && error.message && !error.message.includes(uncertainPlacement) ? `${error.message.trim().replace(/\.?$/, ".")} ${uncertainPlacement}` : uncertainPlacement;
/** The broker answered no, or nothing was sent (see BrokerAdapter.placeOrder): its one-line reason, else undefined. */
function refusal(error: unknown): string | undefined {
  if (!(error instanceof Error) || (error as { refused?: unknown }).refused !== true) return undefined;
  return error.message.trim().replace(/\.$/, "") || "The broker refused this action";
}

/** Terms the broker sets with its figures, or for having none, that the user accepts on the review: never skipped. */
function asksForConsent(preview: BrokerOrderPreview): boolean { return !!preview.disclosure || preview.impactSource === "unavailable"; }
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
/** The same broker order: by native ID when the result has one, else by its acknowledged handle. */
function sameOrder(order: BrokerOrder, result: BrokerOrder): boolean {
  return result.brokerOrderId ? order.brokerOrderId === result.brokerOrderId : result.orderId !== 0 && order.orderId === result.orderId;
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
  private snapshot: BrokerTradingSnapshot = freeze({ phase: "editing", confirmOrders: true });
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
  /** The latest quote the broker's stream pushed per symbol, for the current instrument and its legs. */
  private readonly streamQuotes = new Map<string, Quote>();
  private streamed?: { contractKey: string; quote: BrokerTicketQuote };
  /** The last failed quote request's message, which a streamed quote may clear. */
  private quoteError?: string;
  private entryPending = false;

  constructor(private readonly options: {
    getContext: (request?: BrokerOrderRequest) => BrokerTradingContext; now?: () => number; staleQuoteMs?: number; reviewTtlMs?: number;
    /** A refused change or cancel, settled against the broker's current order. */
    onOutcome?: (outcome: BrokerOrderOutcome) => void;
  }) {
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
    this.publish({ confirmOrders: true });
    // Another profile, account or connection: quotes pushed before it no longer stand.
    this.streamQuotes.clear();
    this.streamed = undefined;
    if (this.mutationPending) return;
    this.modifyOrder = undefined;
    // An order whose outcome is unknown stays the result through a reconnect or a refresh, until a refresh finds it:
    // dropping it would let the same draft be reviewed and placed a second time.
    if (this.uncertain()) {
      this.publish({ review: undefined, cancelOrder: undefined, quote: undefined, loadingQuote: false, error: this.uncertainError() });
      return;
    }
    const changed = this.snapshot.draft || this.snapshot.cancelOrder || this.snapshot.result;
    this.publish({
      phase: "editing", modifying: false, review: undefined, receipt: undefined, result: undefined, cancelOrder: undefined, quote: undefined, loadingQuote: false,
      error: changed ? "Profile, account or connection changed. Review the order again." : undefined,
    });
  }

  /** The last order action's outcome is unknown: the broker may hold the order. */
  uncertain(): boolean {
    return this.snapshot.result?.status.toUpperCase() === "UNKNOWN";
  }

  /** A lost placement asks the trader to check before placing again; a change the broker numbered is being checked. */
  private uncertainError(): string {
    return this.snapshot.result?.orderId ? uncertainChange : uncertainPlacement;
  }

  private editable(): void {
    if (this.disposed) throw new Error("This order ticket is closed.");
    if (this.mutationPending) throw new Error("An order action is already pending.");
    if (this.uncertain()) throw new Error(this.uncertainError());
  }

  setDraft(request: BrokerOrderRequest): void {
    this.editable();
    const original = this.modifyOrder;
    if (original && (canonical(request.contract) !== canonical(original.contract) || canonical(request.legs ?? null) !== canonical(original.legs ?? null)
      || request.action !== original.action || request.accountId !== original.accountId || request.orderType !== original.orderType || request.tif !== original.tif)) {
      throw new Error("A modification keeps the original account, instrument, legs, side, type and time in force.");
    }
    // A spread's legs are its instrument: other legs need another quote.
    const changedContract = canonical([request.contract, request.legs ?? null]) !== canonical([this.snapshot.draft?.contract, this.snapshot.draft?.legs ?? null]);
    this.version++;
    this.gate = undefined;
    if (changedContract) { this.quoteVersion++; this.modifyOrder = undefined; this.streamQuotes.clear(); this.streamed = undefined; }
    this.publish({ phase: "editing", draft: copy(request), modifying: !!this.modifyOrder, review: undefined, receipt: undefined, cancelOrder: undefined, result: undefined, error: undefined,
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
    const strategy = isStrategyOrder(request);
    if (strategy) this.checkLegs(request, context, capabilities);
    // A spread's short legs are the broker's to check: its preview answers for margin and holdings.
    if (request.action === "SELL" && !capabilities.shortSelling && !strategy) {
      if (context.availablePosition === undefined || !Number.isFinite(context.availablePosition)) throw new Error("Refresh the position before selling. The held quantity is unavailable.");
      if (request.quantity > Math.max(0, context.availablePosition)) throw new Error("Sell quantity exceeds the held position. This broker has not enabled short selling.");
    }
    if (!capabilities.fractionalQuantity && !Number.isInteger(request.quantity)) throw new Error("This instrument requires a whole quantity.");
    if (capabilities.quantityStep !== undefined && !matchesNumberStep(request.quantity, capabilities.quantityStep)) throw new Error("Quantity does not match the broker's allowed increment.");
    if (!capabilities.tif.includes(request.tif ?? "DAY")) throw new Error("This broker does not support the selected time in force.");
    if (request.outsideRth && (!capabilities.extendedHours || (capabilities.extendedHoursTif && !capabilities.extendedHoursTif.includes(request.tif ?? "DAY")))) throw new Error("Extended hours are unavailable for this order and time in force.");
    const limit = request.orderType === "LMT" || request.orderType === "STP LMT";
    const stop = request.orderType === "STP" || request.orderType === "STP LMT";
    for (const [needed, value, label] of [[limit, request.limitPrice, "limit"], [stop, request.stopPrice, "stop"]] as const) {
      if (needed && !positive(value)) throw new Error(`Enter a valid ${label} price.`);
      if (!needed && value !== undefined) throw new Error(`Remove the ${label} price for this order type.`);
      const decimals = capabilities.priceDecimals;
      if (value !== undefined && decimals !== undefined && (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || Number(value.toFixed(decimals)) !== value)) {
        throw new Error("Price precision exceeds the broker's limit.");
      }
      if (value !== undefined && capabilities.priceStep !== undefined && !matchesNumberStep(value, capabilities.priceStep)) throw new Error("Price does not match the broker's allowed increment.");
    }
    return copy(request);
  }

  private checkLegs(request: BrokerOrderRequest, context: BrokerTradingContext, capabilities: BrokerTradingCapabilities): void {
    const legs = request.legs ?? [];
    const maxLegs = capabilities.maxLegs ?? 0;
    if (maxLegs < 2) throw new Error("This broker does not take multi-leg orders here.");
    if (request.contract.secType?.toUpperCase() !== "BAG" || legs.length < 2 || legs.length > maxLegs) throw new Error(`This broker takes spreads of 2 to ${maxLegs} legs.`);
    const identities = new Set<string>();
    for (const leg of legs) {
      const identity = optionContractIdentity(leg.contract);
      if (!identity || leg.contract.brokerId !== context.adapter.id || (leg.contract.brokerInstanceId && leg.contract.brokerInstanceId !== context.instance.id)) throw new Error("Every leg must be an option from this broker profile.");
      if (leg.contract.symbol.trim().toUpperCase() !== request.contract.symbol.trim().toUpperCase()) throw new Error("Every leg must be an option on the spread's underlying.");
      if (!["BUY", "SELL"].includes(leg.action) || !Number.isSafeInteger(leg.ratio) || leg.ratio <= 0) throw new Error("Every leg needs a side and a whole number of contracts.");
      if (identities.has(identity)) throw new Error("A contract can appear in only one leg.");
      identities.add(identity);
    }
  }

  private quoteRisk(quote: BrokerTicketQuote): string {
    return `${quote.delayed}:${this.quoteIsStale(quote.quote)}`;
  }

  private quoteIsStale(quote: Quote): boolean {
    return quote.stale === true || !Number.isFinite(quote.lastUpdated) || this.now() - quote.lastUpdated > this.staleQuoteMs;
  }

  /** The ticket's quote from the broker's answer, checked against the draft it was asked for. */
  private ticketQuote(context: BrokerTradingContext, draft: BrokerOrderRequest, quote: Quote | null, legQuotes?: Quote[]): BrokerTicketQuote {
    const compact = (symbol: string) => symbol.replace(/\s+/g, "").toUpperCase();
    if (legQuotes) {
      if (legQuotes.some((legQuote, index) => compact(legQuote.symbol) !== compact(draft.legs![index]!.contract.localSymbol ?? draft.legs![index]!.contract.symbol))) throw new Error("The broker returned a quote for another contract than a leg.");
      if (!quote) throw new Error("The broker has no bid and ask for every leg of this spread.");
    } else {
      const allowedSymbols = [draft.contract.symbol, draft.contract.localSymbol].filter(Boolean).map((symbol) => compact(symbol!));
      if (!quote || !allowedSymbols.includes(compact(quote.symbol)) || !positive(quote.price)) throw new Error("The broker returned no usable quote for this instrument.");
    }
    const delayed = quote.dataSource !== "live" || context.connection.quoteData !== "realtime";
    return { quote: copy(quote), brokerId: context.adapter.id, brokerInstanceId: context.instance.id,
      sourceLabel: `${context.adapter.name}${delayed ? ", delayed" : ""}`, receivedAt: this.now(), delayed,
      stale: this.quoteIsStale(quote), ...(legQuotes ? { legs: copy(legQuotes) } : {}) };
  }

  /** The symbol a stream target names for the draft's instrument, or for each of a spread's legs. */
  static streamSymbols(draft: BrokerOrderRequest): string[] {
    return draft.legs?.length ? draft.legs.map((leg) => leg.contract.localSymbol ?? leg.contract.symbol) : [draft.contract.symbol];
  }

  /**
   * A quote the broker's stream pushed for the draft's instrument or one of
   * its legs. It replaces the ticket's quote once every leg has one, under the
   * same checks as a requested quote.
   */
  applyStreamQuote(symbol: string, quote: Quote): void {
    if (this.disposed) return;
    const draft = this.snapshot.draft;
    if (!draft) return;
    const key = symbol.replace(/\s+/g, "").toUpperCase();
    if (!BrokerTradingController.streamSymbols(draft).some((value) => value.replace(/\s+/g, "").toUpperCase() === key)) return;
    this.streamQuotes.set(key, quote);
    const context = this.options.getContext(draft);
    if (context.connection.state !== "connected") return;
    const strategy = !!draft.legs?.length;
    const legQuotes = strategy ? draft.legs!.map((leg) => this.streamQuotes.get((leg.contract.localSymbol ?? leg.contract.symbol).replace(/\s+/g, "").toUpperCase())) : undefined;
    if (legQuotes?.some((value) => !value)) return;
    try {
      const value = this.ticketQuote(context, draft, legQuotes ? strategyQuote(draft, legQuotes as Quote[]) : quote, legQuotes as Quote[] | undefined);
      this.streamed = { contractKey: canonical([draft.contract, draft.legs ?? null]), quote: value };
      // The stream answered what a quote request could not.
      const answered = this.snapshot.error !== undefined && this.snapshot.error === this.quoteError;
      this.publish({ quote: value, loadingQuote: false, ...(answered ? { error: undefined } : {}) });
    } catch { /* A quote that fails the checks leaves the last good one. */ }
  }

  /** A streamed quote for the current draft, still being pushed, stands in for asking. */
  private currentStreamQuote(draft: BrokerOrderRequest): BrokerTicketQuote | undefined {
    const streamed = this.streamed;
    if (!streamed || streamed.contractKey !== canonical([draft.contract, draft.legs ?? null])) return undefined;
    // A spread's net quote is made from its legs, so the legs say whether it is still streamed.
    const quotes = streamed.quote.legs ?? [streamed.quote.quote];
    // The stream repeats an unchanged quote at least every minute while it is up.
    return quotes.every((quote) => quote.delivery === "stream") && this.now() - streamed.quote.receivedAt <= STREAM_QUOTE_MAX_SILENCE_MS ? streamed.quote : undefined;
  }

  async loadQuote(): Promise<BrokerTicketQuote> {
    const { context } = this.context(false);
    const draft = this.snapshot.draft;
    if (!draft || !context.adapter.getQuote) throw new Error("This broker cannot provide a quote for the ticket.");
    // A new quote answers only the last quote's failure; why a review ended, say, stays in view.
    const quoteErrorCleared = this.snapshot.error !== undefined && this.snapshot.error === this.quoteError ? { error: undefined } : {};
    const streamed = this.currentStreamQuote(draft);
    if (streamed) {
      const value = { ...copy(streamed), stale: this.quoteIsStale(streamed.quote) };
      this.publish({ quote: value, loadingQuote: false, ...quoteErrorCleared });
      return copy(value);
    }
    const instrumentKey = (request?: BrokerOrderRequest) => canonical([request?.contract, request?.legs ?? null]);
    const fingerprint = this.key(), contractKey = instrumentKey(draft), version = ++this.quoteVersion;
    this.publish({ loadingQuote: true, ...quoteErrorCleared });
    try {
      const strategy = !!draft.legs?.length;
      // A spread is priced from its legs' quotes at the same broker; it has no quote of its own.
      const legQuotes = strategy ? await Promise.all(draft.legs!.map((leg) => context.adapter.getQuote!(leg.contract.localSymbol ?? leg.contract.symbol, context.instance, leg.contract.exchange, copy(leg.contract)))) : undefined;
      const quote = legQuotes ? strategyQuote(draft, legQuotes) : await context.adapter.getQuote(draft.contract.symbol, context.instance, draft.contract.exchange, copy(draft.contract));
      if (this.disposed || version !== this.quoteVersion || fingerprint !== this.key() || contractKey !== instrumentKey(this.snapshot.draft)) throw new Error("The quote belongs to an earlier ticket selection. Refresh it.");
      // The stream answered while this request ran: its quote is the newer one.
      const pushed = this.currentStreamQuote(draft);
      const result = pushed ? { ...copy(pushed), stale: this.quoteIsStale(pushed.quote) } : this.ticketQuote(context, draft, quote, legQuotes);
      this.publish({ quote: result, loadingQuote: false });
      return copy(result);
    } catch (error) {
      if (version === this.quoteVersion) {
        this.quoteError = errorMessage(error, "The broker quote is unavailable.");
        this.publish({ loadingQuote: false, error: this.quoteError });
      }
      throw error;
    }
  }

  applyPriceDefault(source: "bid" | "ask" | "mid" | "last", field: "limitPrice" | "stopPrice" = "limitPrice"): void {
    this.editable();
    this.syncContext();
    const draft = this.snapshot.draft, value = this.snapshot.quote;
    if (!draft || !value) throw new Error("Load this broker's quote before choosing a price.");
    const quote = value.quote;
    // A spread's last is its mid: legs do not trade together.
    const price = source === "mid" || (source === "last" && draft.legs?.length) ? positive(quote.bid) && positive(quote.ask) ? (quote.bid + quote.ask) / 2 : undefined : source === "last" ? quote.price : quote[source];
    if (!positive(price)) throw new Error("That broker quote price is unavailable.");
    // To the tick: a sub-penny print is no limit for a stock above a dollar.
    const capabilities = tradingCapabilities(this.options.getContext(draft), draft);
    const step = capabilities.priceStep ?? ticketEditingPriceStep(price, capabilities.priceDecimals);
    const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
    const rounded = Number((Math.round(price / step) * step).toFixed(Math.min(18, decimals)));
    this.setDraft({ ...draft, [field]: positive(rounded) ? rounded : price });
  }

  setConfirmOrders(confirm: boolean): void {
    this.editable();
    const { account } = this.context(false);
    if (this.entryPending || this.snapshot.phase !== "editing") throw new Error("Wait for the current order review before changing confirmation.");
    if (!confirm && account.tradingMode !== "simulation") throw new Error("Only simulation accounts can skip confirmation.");
    this.publish({ confirmOrders: confirm });
  }

  /** One deliberate entry action. Even fast SIM orders consume a fresh exact-draft review. */
  async submitFromEntry(): Promise<void> {
    this.editable();
    const { account } = this.context();
    if (this.entryPending || this.snapshot.phase !== "editing") throw new Error("An order action is already pending or needs reconciliation.");
    const fast = !this.snapshot.confirmOrders && account.tradingMode === "simulation" && !this.modifyOrder;
    this.entryPending = true;
    try {
      await this.prepareReview(fast);
      // New risk information cannot be waived by a session preference, nor can the broker's terms.
      const review = this.snapshot.review;
      if (fast && review && !review.requiresTypedConfirmation && !review.warnings.length && !review.preview.errors?.length && !asksForConsent(review.preview)) await this.submitReviewed(undefined, true);
    } finally { this.entryPending = false; }
  }

  async review(): Promise<void> {
    if (this.entryPending) throw new Error("An order action is already pending.");
    await this.prepareReview();
  }

  private async prepareReview(skipConfirmation = false): Promise<void> {
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
      // A buy stop at or under the ask, or a sell stop at or over the bid, is already triggered: it trades now.
      const touch = request.action === "SELL" ? quote.quote.bid : quote.quote.ask;
      if ((request.orderType === "STP" || request.orderType === "STP LMT") && positive(request.stopPrice) && positive(touch)
        && (request.action === "SELL" ? request.stopPrice >= touch : request.stopPrice <= touch)) {
        warnings.push(request.action === "SELL" ? "This sell stop is at or above the bid, so it triggers at once." : "This buy stop is at or below the ask, so it triggers at once.");
      }
      if (quote.quote.marketState === "CLOSED") warnings.push("The broker reports the market is closed. The order may wait for another session.");
      // Legs whose quotes net the other way: a debit order that would be paid, or a credit order that would pay.
      if (request.legs?.length && Number.isFinite(quote.quote.price) && quote.quote.price <= 0) warnings.push(request.action === "BUY"
        ? "At current quotes this spread receives a credit. Choose Sell to be paid for it." : "At current quotes this spread costs a debit. Choose Buy to pay for it.");
      const estimate = preview.estimatedCost ?? (orderEstimatePrice(request, quote.quote) ?? NaN) * request.quantity * Number(request.contract.multiplier ?? "1");
      if (positive(account.buyingPower) && Number.isFinite(estimate) && Math.abs(estimate) > account.buyingPower * 0.25) warnings.push("This order exceeds 25% of the account's buying power.");
      const result: BrokerOrderReview = { request, preview: copy(preview), warnings: [...new Set(warnings)], account: copy(account), brokerName: context.adapter.name,
        createdAt: this.now(), mode: this.modifyOrder ? "modify" : "place", requiresTypedConfirmation: account.tradingMode !== "simulation", confirmationText: request.contract.symbol.toUpperCase() };
      this.gate = { context: fingerprint, request: canonical(request), version, quoteRisk: this.quoteRisk(quote), order: this.modifyOrder ? copy(this.modifyOrder) : undefined };
      this.publish({ phase: skipConfirmation && !result.warnings.length && !preview.errors?.length && !asksForConsent(preview) ? "previewing" : "review", review: result, quote, error: preview.errors?.length ? "The broker preview has blocking errors." : undefined });
    } catch (error) {
      if (!this.disposed && version === this.version) this.publish({ phase: "editing", review: undefined, error: errorMessage(error, "The broker could not preview this order.") });
      throw error;
    }
  }

  async confirm(typedConfirmation?: string): Promise<void> {
    await this.submitReviewed(typedConfirmation);
  }

  private async submitReviewed(typedConfirmation?: string, fromEntry = false): Promise<void> {
    this.editable();
    const request = this.request(), review = this.snapshot.review, gate = this.gate;
    const { context } = this.context();
    if (this.snapshot.phase !== (fromEntry ? "previewing" : "review") || fromEntry && (this.snapshot.confirmOrders || review?.requiresTypedConfirmation)
      || !review || !gate || gate.version !== this.version || gate.context !== this.key() || gate.request !== canonical(request)) {
      throw new Error("Review the current order before submitting.");
    }
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
      if (!Number.isSafeInteger(result.orderId) || result.orderId <= 0 || (result.accountId && result.accountId !== request.accountId)
        || (result.brokerInstanceId && result.brokerInstanceId !== context.instance.id) || result.contract.brokerId !== context.adapter.id) {
        throw new Error("The broker's order acknowledgement could not be verified.");
      }
      this.publish({ phase: "result", result: copy(result), resultQuantities: "confirmed", review: undefined, receipt: review });
    } catch (error) {
      const reason = refusal(error);
      if (reason && gate.order) await this.settleRefusal(gate.order, reason, "modify");
      // A refused placement placed nothing: the order is the draft again, with the broker's reason.
      else if (reason) this.publish({ phase: "editing", review: undefined, receipt: undefined, error: reason });
      else {
        this.publish({ phase: "result", review: undefined, receipt: review, result: this.unknown(request, gate.order), resultQuantities: gate.order ? "last-known" : "unconfirmed",
          error: gate.order ? uncertainChange : uncertainAfter(error) });
      }
    } finally { this.mutationPending = false; }
  }

  beginModify(order: BrokerOrder): void {
    this.editable();
    const request = this.orderRequest(order);
    const { context, capabilities } = this.context(true, request);
    this.checkOrder(order, context, "modify");
    if (!capabilities.modify || !context.adapter.modifyOrder) throw new Error("This broker does not support modifying this order.");
    if (!["MKT", "LMT", "STP", "STP LMT"].includes(order.orderType)) throw new Error("This order type cannot be modified in the shared ticket.");
    this.modifyOrder = undefined;
    this.setDraft({ ...request, brokerInstanceId: context.instance.id });
    this.modifyOrder = copy(order);
    this.publish({ modifying: true });
  }

  /** An order being replaced can still be cancelled: the cancel takes whichever terms the broker holds. */
  /** The working order a modify replaces, as it was when the change began. */
  modifyingOrder(): BrokerOrder | undefined { return this.modifyOrder && copy(this.modifyOrder); }

  private checkOrder(order: BrokerOrder, context: BrokerTradingContext, action: "modify" | "cancel"): void {
    if (order.accountId !== context.accountId || (order.brokerInstanceId && order.brokerInstanceId !== context.instance.id) || order.contract.brokerId !== context.adapter.id) throw new Error("Select the order's original broker profile and account.");
    const status = order.status.toUpperCase();
    if (TERMINAL.has(status)) throw new Error("This order has ended.");
    if (status === "PENDING_CANCEL") throw new Error("This order is already being cancelled.");
    if (status === "PENDING_REPLACE" && action === "modify") throw new Error("The broker has not taken the last change yet. Wait for it, or cancel the order.");
    // An order the venue has not acknowledged can be cancelled, not replaced: a replacement can lose it (Aries, in simulation).
    if (status === "PENDING_NEW" && action === "modify") throw new Error("The broker has not acknowledged this order yet. Wait for it, or cancel the order.");
    if (status === "UNKNOWN") throw new Error("The broker has not confirmed this order's last change yet.");
  }

  private orderRequest(order: BrokerOrder): BrokerOrderRequest {
    return { brokerInstanceId: order.brokerInstanceId, accountId: order.accountId, contract: copy(order.contract), action: order.action,
      orderType: order.orderType as BrokerOrderRequest["orderType"], quantity: order.quantity, limitPrice: order.limitPrice, stopPrice: order.stopPrice, tif: order.tif,
      ...(order.legs?.length ? { legs: copy(order.legs) } : {}) };
  }

  requestCancel(order: BrokerOrder): void {
    this.editable();
    const { context, capabilities } = this.context(true, this.orderRequest(order));
    this.checkOrder(order, context, "cancel");
    if (!capabilities.cancel || !context.adapter.cancelOrder) throw new Error("This broker does not support cancelling this order.");
    this.version++;
    this.gate = { context: this.key(), request: canonical(order), version: this.version, quoteRisk: "" };
    this.publish({ phase: "cancel-review", cancelOrder: copy(order), review: undefined, receipt: undefined, error: undefined });
  }

  async confirmCancel(confirmed: boolean): Promise<void> {
    this.editable();
    if (!confirmed) { this.reset(); return; }
    const order = this.snapshot.cancelOrder, gate = this.gate;
    const { context, capabilities } = this.context(true, order ? this.orderRequest(order) : undefined);
    if (!capabilities.cancel || !context.adapter.cancelOrder || this.snapshot.phase !== "cancel-review" || !order
      || !gate || gate.context !== this.key() || gate.version !== this.version || gate.request !== canonical(order)) {
      throw new Error("Confirm cancellation of the current order first.");
    }
    this.checkOrder(order, context, "cancel");
    this.gate = undefined;
    this.version++;
    this.mutationPending = true;
    this.publish({ phase: "cancelling", error: undefined });
    try {
      await context.adapter.cancelOrder(context.instance, order.orderId);
      this.publish({ phase: "result", cancelOrder: undefined, resultQuantities: "last-known", result: { ...copy(order), status: "PENDING_CANCEL", updatedAt: this.now() } });
    } catch (error) {
      const reason = refusal(error);
      if (reason) await this.settleRefusal(order, reason, "cancel");
      else this.publish({ phase: "result", cancelOrder: undefined, resultQuantities: "last-known", result: { ...copy(order), status: "UNKNOWN", updatedAt: this.now() }, error: uncertainChange });
    } finally { this.mutationPending = false; }
  }

  /** The order as the broker reports it now, by its handle; undefined when the broker cannot say. */
  private async lookup(order: BrokerOrder): Promise<BrokerOrder | undefined> {
    const { context } = this.context(false);
    try {
      const orders = context.adapter.getOrderStatus && order.orderId !== 0
        ? [await context.adapter.getOrderStatus(context.instance, order.orderId)]
        : await context.adapter.listOpenOrders?.(context.instance) ?? [];
      return orders.find((value): value is BrokerOrder => !!value && value.accountId === order.accountId
        && value.contract.symbol === order.contract.symbol && (value.orderId === order.orderId || sameOrder(value, order)));
    } catch { return undefined; }
  }

  /**
   * After the broker refused a change or cancel, which leaves the order as it was, the order as the broker now
   * reports it decides the one line said about it: "Already filled" when it ended first, "Order changed in Aries,
   * refreshed" when it moved on elsewhere, else the broker's reason. A refused change of an order that stands as it
   * was keeps the ticket on the change, with the reason in the form.
   */
  private async settleRefusal(order: BrokerOrder, reason: string, action: "modify" | "cancel"): Promise<void> {
    const brokerName = this.context(false).context.adapter.name;
    const current = await this.lookup(order);
    if (this.disposed) return;
    const now = current ?? order;
    const label = brokerOrderStatus(now.status);
    const ended = brokerOrderDone(now.status);
    const changed = !!current && (current.brokerOrderId !== order.brokerOrderId || label !== brokerOrderStatus(order.status) || current.quantity !== order.quantity
      || current.filled !== order.filled || current.limitPrice !== order.limitPrice || current.stopPrice !== order.stopPrice);
    if (action === "modify" && !ended && !changed) {
      this.publish({ phase: "editing", review: undefined, receipt: undefined, error: reason });
      return;
    }
    this.publish({ phase: "result", cancelOrder: undefined, review: undefined, result: copy(now), resultQuantities: current ? "confirmed" : "last-known", error: undefined });
    const title = ended ? label === "Rejected" ? reason : `Already ${label.toLowerCase()}` : changed ? `Order changed in ${brokerName}, refreshed` : reason;
    this.options.onOutcome?.({ title, type: ended || changed ? "info" : "error", order: copy(now) });
  }

  private unknown(request: BrokerOrderRequest, original?: BrokerOrder): BrokerOrder {
    return { ...original, orderId: original?.orderId ?? 0, brokerInstanceId: request.brokerInstanceId, accountId: request.accountId, contract: copy(request.contract),
      ...(request.legs?.length ? { legs: copy(request.legs) } : {}),
      status: "UNKNOWN", action: request.action, orderType: request.orderType, quantity: request.quantity, filled: original?.filled ?? 0,
      remaining: original?.remaining ?? request.quantity, limitPrice: request.limitPrice, stopPrice: request.stopPrice, tif: request.tif, updatedAt: this.now() };
  }

  async refreshResult(): Promise<void> {
    const result = this.snapshot.result;
    if (!result) return;
    const { context } = this.context(false);
    if (!context.adapter.listOpenOrders && !context.adapter.getOrderStatus) throw new Error("Refresh this order in your broker.");
    const fingerprint = this.key();
    const orders = context.adapter.getOrderStatus && result.orderId !== 0
      ? [await context.adapter.getOrderStatus(context.instance, result.orderId)].filter((order): order is BrokerOrder => order !== null)
      : await context.adapter.listOpenOrders?.(context.instance) ?? [];
    if (this.disposed || fingerprint !== this.key() || this.snapshot.result !== result) return;
    const current = orders.find((order) => order.accountId === result.accountId && order.contract.symbol === result.contract.symbol && sameOrder(order, result));
    if (current) this.publish({ result: copy(current), resultQuantities: "confirmed", error: current.status === "UNKNOWN" ? uncertainChange : undefined });
    // Absence from open orders does not prove a fill, rejection or cancellation.
  }

  /**
   * The result's order as the broker last reported it, from the app's order
   * feed (see useFeedOrderResult). Only the same account and native order (or
   * acknowledged handle) updates it; an order that ended does not go back to
   * working, and an unknown outcome waits for an end or a refresh. Answers the
   * result as it now stands.
   */
  applyOrderUpdate = (order: BrokerOrder): BrokerOrder | undefined => {
    const result = this.snapshot.result;
    if (this.disposed || this.mutationPending || !result || order.accountId !== result.accountId || !sameOrder(order, result)) return result;
    if (order.contract.brokerId !== result.contract.brokerId || (order.brokerInstanceId && result.brokerInstanceId && order.brokerInstanceId !== result.brokerInstanceId)) return result;
    if (TERMINAL.has(result.status.toUpperCase()) && !TERMINAL.has(order.status.toUpperCase())) return result;
    // An action whose outcome is unknown is settled by the order ending, or by refreshing it; a working order may not have seen it yet.
    if (result.status.toUpperCase() === "UNKNOWN" && !TERMINAL.has(order.status.toUpperCase())) return result;
    if (canonical(order) === canonical(result)) return result;
    this.publish({ result: copy(order), resultQuantities: "confirmed", error: order.status === "UNKNOWN" ? uncertainChange : undefined });
    return this.snapshot.result;
  };

  reset(): void {
    this.editable();
    this.version++;
    this.gate = undefined;
    this.modifyOrder = undefined;
    this.publish({ phase: "editing", modifying: false, review: undefined, receipt: undefined, result: undefined, cancelOrder: undefined, error: undefined });
  }

  dispose(): void { this.disposed = true; this.version++; this.quoteVersion++; this.gate = undefined; this.listeners.clear(); this.streamQuotes.clear(); }
}
