import type { CommandDef, GloomPluginContext } from "../../../types/plugin";

export interface TradeIntent {
  action: "BUY" | "SELL";
  quantity?: number;
  limitPrice?: number;
}

const pendingIntents = new Map<string, TradeIntent>();

/** Only the opaque token enters saved pane state; a draft cannot replay after restart. */
export function createTradeIntent(value: TradeIntent): string {
  while (pendingIntents.size >= 32) pendingIntents.delete(pendingIntents.keys().next().value!);
  const id = crypto.randomUUID();
  pendingIntents.set(id, { ...value });
  return id;
}

export function takeTradeIntent(id: string | null): TradeIntent | undefined {
  if (!id) return;
  const intent = pendingIntents.get(id);
  pendingIntents.delete(id);
  return intent;
}

function positiveDecimal(value: string | undefined, label: string): number {
  if (!value || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive decimal number.`);
  }
  return Number(value);
}

export function parseTradeShortcut(arg: string): Record<string, string> {
  const parts = arg.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 3) throw new Error("Use BUY or SELL followed by ticker, quantity, and an optional limit price.");
  const symbol = parts[0]!.toUpperCase();
  if (!/^[A-Z0-9^][A-Z0-9.^:/=_-]*$/.test(symbol) || !/[A-Z]/.test(symbol)) throw new Error("Enter a ticker symbol before the quantity.");
  const quantity = positiveDecimal(parts[1], "Quantity");
  const limitPrice = parts[2] === undefined ? undefined : positiveDecimal(parts[2], "Limit price");
  return { symbol, quantity: String(quantity), ...(limitPrice === undefined ? {} : { limitPrice: String(limitPrice) }) };
}

export function openTradeTicket(ctx: Pick<GloomPluginContext, "pinTicker">, symbol: string, intent: TradeIntent): void {
  ctx.pinTicker(symbol, { tabId: "broker-trade", tabState: { brokerTradeIntent: createTradeIntent(intent) } });
}

export function createTradeCommand(ctx: Pick<GloomPluginContext, "pinTicker">, action: "BUY" | "SELL", supported: (symbol: string) => boolean = () => true): CommandDef {
  return {
    id: `broker-${action.toLowerCase()}-ticket`, label: action === "BUY" ? "Buy" : "Sell",
    description: "Open a broker order ticket for review", keywords: [action.toLowerCase(), "trade", "order", "broker"],
    category: "portfolio", shortcut: action,
    shortcutArg: { kind: "text", placeholder: "ticker quantity [limit price]", parse: parseTradeShortcut },
    execute(values) {
      const input = parseTradeShortcut([values?.symbol ?? "", values?.quantity ?? "", ...(values?.limitPrice === undefined ? [] : [values.limitPrice])].join(" "));
      if (!supported(input.symbol!)) throw new Error(`Connect a broker that supports ${input.symbol} in Brokers.`);
      openTradeTicket(ctx, input.symbol!, { action, quantity: Number(input.quantity), ...(input.limitPrice === undefined ? {} : { limitPrice: Number(input.limitPrice) }) });
    },
  };
}
