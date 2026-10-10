/**
 * What the per-call confirmation says: the exact action in plain words, with
 * the arguments that matter (plugin, operation, symbol, side, size), so the
 * person can tell an order from a lookup before allowing it.
 */
export interface CallSummaryLine {
  label: string;
  value: string;
}

export interface CallSummary {
  title: string;
  lines: CallSummaryLine[];
}

const KEY_ARGUMENTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["symbol", "ticker", "instrument", "contract", "conid"], label: "Symbol" },
  { keys: ["side", "action", "direction"], label: "Side" },
  { keys: ["quantity", "qty", "size", "shares", "units", "contracts"], label: "Size" },
  { keys: ["amount", "notional", "value", "cash"], label: "Amount" },
  { keys: ["orderType", "type", "kind"], label: "Order type" },
  { keys: ["price", "limitPrice", "limit", "stopPrice", "stop"], label: "Price" },
  { keys: ["timeInForce", "tif"], label: "Time in force" },
  { keys: ["account", "accountId", "portfolioId"], label: "Account" },
  { keys: ["to", "recipient", "destination", "channelId", "email"], label: "To" },
  { keys: ["message", "text", "content", "body"], label: "Message" },
];

const MAX_VALUE = 80;

export function shortValue(value: unknown): string {
  const text = typeof value === "string"
    ? value
    : value === undefined
      ? ""
      : JSON.stringify(value) ?? String(value);
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > MAX_VALUE ? `${single.slice(0, MAX_VALUE - 1)}…` : single;
}

/** Lines for the order-like fields of a payload, then a count of the rest. */
export function keyArgumentLines(payload: unknown): CallSummaryLine[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload === undefined || payload === null ? [] : [{ label: "Input", value: shortValue(payload) }];
  }
  const record = payload as Record<string, unknown>;
  const used = new Set<string>();
  const lines: CallSummaryLine[] = [];
  for (const { keys, label } of KEY_ARGUMENTS) {
    const key = keys.find((candidate) => record[candidate] !== undefined && record[candidate] !== null && record[candidate] !== "");
    if (!key) continue;
    used.add(key);
    lines.push({ label, value: shortValue(record[key]) });
  }
  const rest = Object.keys(record).filter((key) => !used.has(key));
  if (rest.length > 0 && rest.length <= 3) {
    for (const key of rest) lines.push({ label: key, value: shortValue(record[key]) });
  } else if (rest.length > 3) {
    lines.push({ label: "Other fields", value: rest.join(", ") });
  }
  return lines;
}
