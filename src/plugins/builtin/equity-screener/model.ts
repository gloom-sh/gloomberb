import {
  CATEGORY_FIELDS,
  NUMERIC_FIELDS,
  type NumericField,
  type ScreenMetric,
  type ScreenCriterion,
  type ScreenDefinition,
  type ScreenFieldDefinition,
  type ScreenOperator,
  type ScreenPayload,
  type ScreenRow,
} from "../../../api-client/equity-screener";
import { canonicalExchange } from "../../../utils/exchanges";
import { formatCompact } from "../../../utils/format";

/**
 * Column headers. Currency sits in the footer; percentage fields carry %.
 * Growth and margins come from the latest fiscal-year statement, so they say FY.
 */
export const SHORT_LABELS: Record<NumericField, string> = {
  price: "PRICE",
  changePercent: "CHG %",
  volume: "VOLUME",
  averageVolume20d: "AVG VOL 20D",
  relativeVolume: "REL VOL",
  marketCap: "MKT CAP",
  trailingPE: "P/E",
  forwardPE: "FWD P/E",
  enterpriseToRevenue: "EV/REV",
  dividendYieldPercent: "DIV YLD %",
  revenueGrowthPercent: "FY REV GR %",
  earningsGrowthPercent: "FY EARN GR %",
  grossMarginPercent: "FY GROSS MGN %",
  operatingMarginPercent: "FY OP MGN %",
  netMarginPercent: "FY NET MGN %",
  shortInterestShares: "SHORT INT",
  shortInterestChangePercent: "SI CHG %",
  daysToCover: "DAYS COVER",
  insiderPurchases90d: "INS BUYS 90D",
  insiderSales90d: "INS SELLS 90D",
  institutionalHolders: "13F HOLDERS",
  institutionalNewHolders: "13F NEW",
  institutionalExits: "13F EXITS",
};
const COMPACT = new Set<NumericField>(["marketCap", "volume", "averageVolume20d", "shortInterestShares"]);
const SIGNED = new Set<NumericField>(["changePercent", "revenueGrowthPercent", "earningsGrowthPercent", "shortInterestChangePercent"]);
const COUNTS = new Set<NumericField>(["insiderPurchases90d", "insiderSales90d", "institutionalHolders", "institutionalNewHolders", "institutionalExits"]);
const MONETARY = new Set<NumericField>(["price", "marketCap"]);
/** Shown after the screen's own criteria when the pane has room. */
const CONTEXT_FIELDS: NumericField[] = ["marketCap", "price", "changePercent", "trailingPE", "revenueGrowthPercent", "operatingMarginPercent", "dividendYieldPercent"];

export function formatScreenValue(field: NumericField, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  if (COMPACT.has(field)) return formatCompact(value, { fixedDecimals: true });
  if (COUNTS.has(field)) return value.toFixed(0);
  if (field === "price") return value.toFixed(2);
  // A value that rounds to zero prints 0.0, never -0.0.
  const fixed = Math.abs(value) < 0.05 ? "0.0" : value.toFixed(1);
  return SIGNED.has(field) && value > 0 && fixed !== "0.0" ? `+${fixed}` : fixed;
}

/** Source observation date, or the collection date when the provider gives none. */
export function metricDate(metric: ScreenMetric): { text: string; collected: boolean } {
  if (metric.asOf) return { text: metric.asOf.slice(0, 10), collected: false };
  if (metric.value != null && metric.observedAt) return { text: metric.observedAt.slice(0, 10), collected: true };
  return { text: "--", collected: false };
}

/** Focus metric, then the screen's numeric criteria, then context columns. Money needs one currency. */
export function resultFields(definition: ScreenDefinition, metric: NumericField): NumericField[] {
  const numeric = (field: string): field is NumericField => (NUMERIC_FIELDS as readonly string[]).includes(field);
  const fields = [metric, ...definition.criteria.map((criterion) => criterion.field).filter(numeric), ...CONTEXT_FIELDS];
  return [...new Set(fields)].filter((field) => definition.currency || !MONETARY.has(field) || field === metric);
}

export const columnWidth = (field: NumericField) => Math.max(8, SHORT_LABELS[field].length);

export const DEFAULT_SCREEN: ScreenDefinition = {
  version: 1,
  currency: "USD",
  criteria: [{ field: "marketCap", op: "gte", value: 10_000_000_000 }],
  sort: { field: "marketCap", direction: "desc" },
};
export const screenRowId = (row: Pick<ScreenRow, "symbol" | "exchange">) =>
  `${canonicalExchange(row.exchange)}:${row.symbol}`;
export const screenLabel = (field: string) =>
  ({
    trailingPE: "Trailing P/E",
    forwardPE: "Forward P/E",
    enterpriseToRevenue: "EV / revenue",
    marketCap: "Market cap",
    revenueGrowthPercent: "Revenue growth %",
    earningsGrowthPercent: "Earnings growth %",
    operatingMarginPercent: "Operating margin %",
    grossMarginPercent: "Gross margin %",
    netMarginPercent: "Net margin %",
    relativeVolume: "Relative volume",
    insiderPurchases90d: "Insider purchases 90D",
    insiderSales90d: "Insider sales 90D",
    institutionalHolders: "13F holders",
    institutionalNewHolders: "New 13F holders",
    institutionalExits: "13F exits",
    shortInterestShares: "Short interest",
    shortInterestChangePercent: "Short interest change %",
    averageVolume20d: "20D average volume",
    changePercent: "Change %",
    daysToCover: "Days to cover",
    dividendYieldPercent: "Dividend yield %",
  })[field] ??
  field
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (value) => value.toUpperCase());
export function parseCriterion(
  field: ScreenFieldDefinition,
  operator: ScreenOperator,
  text: string,
): ScreenCriterion {
  if (!field.operators.includes(operator))
    throw new Error("Choose a supported operator for this field.");
  if (operator === "present" || operator === "missing")
    return { field: field.id, op: operator };
  if (field.kind === "category") {
    const values = [
      ...new Set(
        text
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (operator !== "in" || !values.length || values.length > 25 || values.some((value) => value.length > 120))
      throw new Error("Enter 1-25 comma-separated values, up to 120 characters each.");
    return {
      field: field.id as (typeof CATEGORY_FIELDS)[number],
      op: "in",
      value: values,
    };
  }
  const values = text.split(",").map(parseThreshold);
  if (values.some((value) => value === null))
    throw new Error("Enter a finite numeric threshold, such as 25 or 10B.");
  if (operator === "between") {
    if (values.length !== 2 || Number(values[0]) > Number(values[1]))
      throw new Error("Enter minimum, maximum in ascending order.");
    return {
      field: field.id as (typeof NUMERIC_FIELDS)[number],
      op: operator,
      value: [Number(values[0]), Number(values[1])],
    };
  }
  if (
    values.length !== 1 ||
    !["gt", "gte", "lt", "lte", "eq"].includes(operator)
  )
    throw new Error("Enter one threshold.");
  return {
    field: field.id as (typeof NUMERIC_FIELDS)[number],
    op: operator as "gte",
    value: Number(values[0]),
  };
}
const SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
/** A plain number or one with a k/M/B/T scale suffix: 25, -0.5, 1e6, 10B. */
export function parseThreshold(text: string): number | null {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([kmbt])?$/i.exec(text.trim().replace(/_/g, ""));
  if (!match) return null;
  const value = Number(match[1]) * (match[2] ? SCALE[match[2].toLowerCase()]! : 1);
  return Number.isFinite(value) ? value : null;
}
const thresholdText = (value: number) =>
  Math.abs(value) >= 1e6 ? formatCompact(value) : String(value);

export function criterionText(criterion: ScreenCriterion): string {
  const symbols = {
    gte: ">=",
    lte: "<=",
    gt: ">",
    lt: "<",
    eq: "=",
    between: "between",
    in: "in",
    present: "present",
    missing: "missing",
  };
  const value = !("value" in criterion)
    ? ""
    : Array.isArray(criterion.value)
      ? ` ${criterion.value.map((item) => (typeof item === "number" ? thresholdText(item) : item)).join(", ")}`
      : ` ${thresholdText(criterion.value)}`;
  return `${screenLabel(criterion.field)} ${symbols[criterion.op]}${value}`;
}
export function parseScreenDefinition(value: unknown): ScreenDefinition {
  if (!value || typeof value !== "object")
    throw new Error("Invalid screen definition.");
  const item = value as ScreenDefinition;
  const fields = [...NUMERIC_FIELDS, ...CATEGORY_FIELDS] as string[];
  if (
    item.version !== 1 ||
    !Array.isArray(item.criteria) ||
    item.criteria.length > 20 ||
    !item.sort ||
    !fields.includes(item.sort.field) ||
    !["asc", "desc"].includes(item.sort.direction) ||
    (item.currency !== null &&
      (typeof item.currency !== "string" || !/^[A-Z]{3}$/.test(item.currency)))
  )
    throw new Error("Invalid screen definition.");
  const criteria = item.criteria.map((criterion) => {
    if (!criterion || !fields.includes(criterion.field))
      throw new Error("Unknown screen field.");
    const numeric = (NUMERIC_FIELDS as readonly string[]).includes(
      criterion.field,
    );
    const operators: ScreenOperator[] = numeric
      ? ["gte", "lte", "gt", "lt", "eq", "between", "present", "missing"]
      : ["in", "present", "missing"];
    if (
      criterion.field === "insiderPurchases90d" ||
      criterion.field === "insiderSales90d"
    )
      operators.splice(0, operators.length, "gte", "gt", "present", "missing");
    if (["present", "missing"].includes(criterion.op) && "value" in criterion)
      throw new Error("Presence criteria have no value.");
    const normalized = parseCriterion(
      {
        id: criterion.field,
        label: "",
        kind: numeric ? "number" : "category",
        unit: "",
        description: "",
        operators,
      },
      criterion.op,
      "value" in criterion
        ? Array.isArray(criterion.value)
          ? criterion.value.join(",")
          : String(criterion.value)
        : "",
    );
    if (JSON.stringify(normalized) !== JSON.stringify(criterion)) {
      // Key order is not semantic. Validation above owns types and operator shape.
      if (
        "value" in normalized &&
        "value" in criterion &&
        JSON.stringify(normalized.value) !== JSON.stringify(criterion.value)
      )
        throw new Error("Invalid criterion value.");
    }
    return normalized;
  });
  if (
    !item.currency &&
    (["price", "marketCap"].includes(item.sort.field) ||
      item.criteria.some(
        (criterion) =>
          ["price", "marketCap"].includes(criterion.field) &&
          !["present", "missing"].includes(criterion.op),
      ))
  )
    throw new Error("Select one currency for price or market-cap comparisons.");
  return { version: 1, currency: item.currency, criteria,
    sort: { field: item.sort.field, direction: item.sort.direction } };
}
const requiredDate = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const validDate = (value: unknown) => value === null || requiredDate(value);
export const screenDefinitionKey = (value: ScreenDefinition) =>
  JSON.stringify(parseScreenDefinition(value));
export function validateScreenPayload(value: unknown): ScreenPayload {
  const data = value as ScreenPayload;
  if (
    !data ||
    data.version !== 1 ||
    !["available", "partial", "unavailable"].includes(data.status) ||
    !Array.isArray(data.rows) ||
    data.rows.length > 200 ||
    !Array.isArray(data.warnings) || data.warnings.some((warning) => typeof warning !== "string") ||
    !data.universe ||
    !Number.isInteger(data.universe.covered) ||
    !Array.isArray(data.universe.currencies) || data.universe.currencies.some((currency) => typeof currency !== "string") ||
    !Number.isInteger(data.universe.matched) ||
    data.universe.matched < 0 ||
    data.universe.covered < data.universe.matched ||
    (data.nextCursor !== null && typeof data.nextCursor !== "string")
  )
    throw new Error("Invalid screener response from Gloom Cloud.");
  parseScreenDefinition(data.definition);
  if (
    data.snapshot &&
    (typeof data.snapshot.id !== "string" ||
      !requiredDate(data.snapshot.assembledAt) ||
      !requiredDate(data.snapshot.expiresAt) || Date.parse(data.snapshot.expiresAt) <= Date.parse(data.snapshot.assembledAt))
  )
    throw new Error("Invalid screener snapshot identity.");
  if (!data.snapshot && data.rows.length)
    throw new Error("Screen rows require a dated snapshot.");
  const ids = new Set<string>();
  for (const row of data.rows) {
    if (
      !row ||
      typeof row.symbol !== "string" ||
      typeof row.exchange !== "string" ||
      !row.metrics ||
      !Array.isArray(row.warnings) ||
      ids.has(screenRowId(row))
    )
      throw new Error("Invalid screener listing identity.");
    ids.add(screenRowId(row));
    for (const field of NUMERIC_FIELDS) {
      const metric = row.metrics[field];
      if (
        !metric ||
        (metric.value !== null && !Number.isFinite(metric.value)) ||
        !validDate(metric.asOf) ||
        !validDate(metric.observedAt) ||
        (metric.value !== null && !metric.asOf && metric.state === "available") ||
        !["available", "partial", "stale", "unavailable"].includes(
          metric.state,
        ) ||
        typeof metric.unit !== "string" ||
        typeof metric.source !== "string" ||
        !metric.percentile ||
        metric.percentile.scope !== "covered-universe" ||
        !Number.isInteger(metric.percentile.sampleCount) ||
        metric.percentile.sampleCount < 0 ||
        (metric.percentile.value !== null &&
          (!Number.isFinite(metric.percentile.value) ||
            metric.percentile.value < 0 ||
            metric.percentile.value > 100))
      )
        throw new Error(`Invalid ${field} observation from Gloom Cloud.`);
    }
  }
  return data;
}
export function appendScreenPage(
  current: ScreenPayload,
  next: ScreenPayload,
): ScreenPayload {
  if (
    !current.snapshot ||
    current.snapshot.id !== next.snapshot?.id ||
    screenDefinitionKey(current.definition) !== screenDefinitionKey(next.definition)
  )
    throw new Error("Screen snapshot changed. Refresh to start again.");
  const rows = new Map(current.rows.map((row) => [screenRowId(row), row]));
  for (const row of next.rows) rows.set(screenRowId(row), row);
  return { ...next, rows: [...rows.values()] };
}
