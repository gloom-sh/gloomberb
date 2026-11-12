import { TIME_RANGES } from "../time-series/range";
import type { CapabilityOperationCliManifest, CapabilitySchema } from "./types";

/** What one field of an operation's input holds. `range` is a TimeRange name; `date` an ISO date or time, or epoch ms. */
type FieldType = "string" | "number" | "boolean" | "object" | "array" | "date" | "range";

interface InputField {
  readonly name: string;
  readonly type: FieldType;
  readonly optional?: true;
}

interface AssetDataOperationSpec {
  readonly summary: string;
  readonly fields: readonly InputField[];
  readonly examples?: readonly string[];
}

const required = (name: string, type: FieldType): InputField => ({ name, type });
const optional = (name: string, type: FieldType): InputField => ({ name, type, optional: true });

const LISTING = [required("ticker", "string"), optional("exchange", "string"), optional("context", "object")] as const;
const RANGE_WORDS = TIME_RANGES.join("|");

/**
 * Each built-in asset-data operation's summary and input, as `gloom api get`
 * lists them and `api invoke` checks a payload against: a missing or
 * mistyped field is named with the fields the operation takes, never a
 * TypeError from inside the source.
 */
const ASSET_DATA_OPERATION_SPECS: Readonly<Record<string, AssetDataOperationSpec>> = {
  canProvide: { summary: "Whether the source answers for a listing", fields: LISTING },
  primaryMarketSourceName: { summary: "Name of the source that serves quotes and bars", fields: [] },
  batchesReads: { summary: "Whether reads of a method go out batched", fields: [required("method", "string")] },
  getCachedFinancialsForTargets: {
    summary: "Saved financials for several listings, without a network read",
    fields: [required("targets", "array"), optional("options", "object")],
  },
  getQuotesBatch: {
    summary: "Quotes for several listings at once",
    fields: [required("targets", "array"), optional("options", "object")],
    examples: ['api invoke asset-data.asset-data-router.getQuotesBatch \'{"targets":[{"symbol":"KO"},{"symbol":"PEP"}]}\''],
  },
  getTickerFinancialsBatch: {
    summary: "Quote, profile and statements for several listings",
    fields: [required("targets", "array"), optional("options", "object")],
  },
  getTickerFinancials: { summary: "Quote, profile and statements for one listing", fields: LISTING },
  getQuote: {
    summary: "Latest quote, with lastTradeTime, retrievedAt, stale and dataSource",
    fields: LISTING,
    examples: ['api invoke asset-data.asset-data-router.getQuote \'{"ticker":"TTEK"}\''],
  },
  getQuoteMetadata: { summary: "Name, currency and exchange of a listing", fields: LISTING },
  getExchangeRate: { summary: "Units of the base currency per one unit of a currency", fields: [required("fromCurrency", "string")] },
  search: { summary: "Listings matching a name or symbol", fields: [required("query", "string"), optional("context", "object")] },
  getSecFilings: {
    summary: "Recent SEC filings",
    fields: [required("ticker", "string"), optional("count", "number"), optional("exchange", "string"), optional("context", "object")],
  },
  getHolders: { summary: "Institutional and fund holders", fields: LISTING },
  getAnalystResearch: { summary: "Analyst ratings and price targets", fields: LISTING },
  getCorporateActions: { summary: "Dividends, splits and reported earnings", fields: LISTING },
  getTickerChanges: { summary: "Symbol changes a listing went through", fields: [required("symbol", "string")] },
  getEarningsCalendar: { summary: "Upcoming and recent earnings dates", fields: [required("symbols", "array"), optional("context", "object")] },
  getSecFilingDocuments: { summary: "Documents of one SEC filing", fields: [required("filing", "object")] },
  getSecFilingContent: { summary: "Text of one SEC filing", fields: [required("filing", "object")] },
  getArticleSummary: { summary: "Summary of a news article", fields: [required("url", "string")] },
  getPriceHistory: {
    summary: "Bars over a range, in the range's bar size",
    fields: [required("ticker", "string"), optional("exchange", "string"), required("range", "range"), optional("context", "object")],
  },
  getPriceHistoryWithMetadata: {
    summary: "Bars over a range, with the bar size served and where coverage starts",
    fields: [required("ticker", "string"), optional("exchange", "string"), required("range", "range"), optional("context", "object")],
    examples: ['api invoke asset-data.asset-data-router.getPriceHistoryWithMetadata \'{"ticker":"KO","range":"ALL"}\''],
  },
  getPriceHistoryForResolutionWithMetadata: {
    summary: "Bars of one size over a range, with metadata",
    fields: [required("ticker", "string"), optional("exchange", "string"), required("bufferRange", "range"), required("resolution", "string"), optional("context", "object")],
  },
  getDetailedPriceHistoryWithMetadata: {
    summary: "Bars of one size between two dates, with metadata",
    fields: [required("ticker", "string"), optional("exchange", "string"), required("startDate", "date"), required("endDate", "date"), required("barSize", "string"), optional("context", "object")],
    examples: ['api invoke asset-data.asset-data-router.getDetailedPriceHistoryWithMetadata \'{"ticker":"KO","startDate":"1990-01-01","endDate":"2026-11-11","barSize":"1d"}\''],
  },
  getPriceHistoryForResolution: {
    summary: "Bars of one size over a range",
    fields: [required("ticker", "string"), optional("exchange", "string"), required("bufferRange", "range"), required("resolution", "string"), optional("context", "object")],
  },
  getDetailedPriceHistory: {
    summary: "Bars of one size between two dates",
    fields: [required("ticker", "string"), optional("exchange", "string"), required("startDate", "date"), required("endDate", "date"), required("barSize", "string"), optional("context", "object")],
  },
  getChartResolutionSupport: { summary: "Bar sizes the source serves for a listing", fields: LISTING },
  getChartResolutionCapabilities: { summary: "Bar sizes and how far back each reaches", fields: LISTING },
  getOptionsChain: {
    summary: "Options chain for one expiry, the nearest when none is given",
    fields: [required("ticker", "string"), optional("exchange", "string"), optional("expirationDate", "number"), optional("context", "object")],
  },
  subscribeQuotes: { summary: "Stream of quotes for several listings", fields: [required("targets", "array")] },
};

function typeWord(type: FieldType): string {
  return type === "range" ? RANGE_WORDS : type === "date" ? "date" : type;
}

/** `{ ticker: string, exchange?: string, context?: object }` */
function inputShape(fields: readonly InputField[]): string {
  if (fields.length === 0) return "{}";
  return `{ ${fields.map((field) => `${field.name}${field.optional ? "?" : ""}: ${typeWord(field.type)}`).join(", ")} }`;
}

/** The value as the field takes it, or undefined when it is not one. A date may come as an ISO string or epoch ms, as JSON carries it. */
function readField(type: FieldType, value: unknown): unknown {
  switch (type) {
    case "string": return typeof value === "string" ? value : undefined;
    case "number": return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "boolean": return typeof value === "boolean" ? value : undefined;
    case "array": return Array.isArray(value) ? value : undefined;
    case "object": return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    case "range": return typeof value === "string" && (TIME_RANGES as string[]).includes(value) ? value : undefined;
    case "date": {
      const date = value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
      return date && Number.isFinite(date.getTime()) ? date : undefined;
    }
  }
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : String(value);
}

/**
 * The schema of one operation's input: the payload must be an object with
 * every required field, each field of its type. A date field is read into a
 * Date. Fields it does not name pass through untouched.
 */
function inputSchema(operationId: string, fields: readonly InputField[]): CapabilitySchema<Record<string, unknown>> {
  const shape = inputShape(fields);
  const refuse = (problem: string): never => {
    throw new Error(`${operationId} takes ${shape}: ${problem}.`);
  };
  return {
    parse(value) {
      if (value != null && (typeof value !== "object" || Array.isArray(value))) refuse(`got ${describeValue(value)}, not an object`);
      const payload = { ...(value as Record<string, unknown> | null | undefined) };
      const known = new Set(fields.map((field) => field.name));
      for (const field of fields) {
        const raw = payload[field.name];
        if (raw == null) {
          if (field.optional) continue;
          const others = Object.keys(payload).filter((key) => !known.has(key));
          refuse(`${field.name} is missing${others.length > 0 ? ` (it got ${others.join(", ")})` : ""}`);
        }
        const read = readField(field.type, raw);
        if (read === undefined) {
          refuse(field.type === "range"
            ? `${field.name} is one of ${TIME_RANGES.join(", ")}, not ${describeValue(raw)}`
            : `${field.name} is a ${typeWord(field.type)}, not ${describeValue(raw)}`);
        }
        payload[field.name] = read;
      }
      return payload;
    },
  };
}

/** An operation's input schema and the summary and input shape `gloom api get` shows; nothing for one without a spec. */
export function assetDataOperationContract(operationId: string): {
  input?: CapabilitySchema<Record<string, unknown>>;
  cli?: CapabilityOperationCliManifest;
} {
  const spec = ASSET_DATA_OPERATION_SPECS[operationId];
  if (!spec) return {};
  return {
    input: inputSchema(operationId, spec.fields),
    cli: { summary: spec.summary, inputShape: inputShape(spec.fields), ...(spec.examples ? { examples: [...spec.examples] } : {}) },
  };
}
