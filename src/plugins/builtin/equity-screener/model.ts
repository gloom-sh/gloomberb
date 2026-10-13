import {
  ATTENTION_FIELDS,
  HIRING_APP_FIELDS,
  CATEGORY_FIELDS,
  NUMERIC_FIELDS,
  RESEARCH_FIELDS,
  KPI_FIELDS,
  SOCIAL_FIELDS,
  VOLATILITY_FIELDS,
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
import { formatCompact, formatNumber } from "../../../utils/format";

/**
 * Column headers. Currency sits in the footer; percentage fields carry %.
 * Growth and margins come from the latest fiscal-year statement, so they say FY.
 */
export const SHORT_LABELS: Record<NumericField, string> = {
  kpiArr: "ARR",
  kpiNrrPercent: "NRR%",
  kpiRpo: "RPO",
  kpiCrpo: "CRPO",
  kpiSubscribers: "SUBSCRIBERS",
  kpiDau: "DAU",
  kpiMau: "MAU",
  kpiGmv: "GMV",
  kpiTakeRatePercent: "TAKE RATE%",
  kpiSameStoreSalesPercent: "SAME STORE%",
  kpiStores: "STORES",
  kpiBacklog: "BACKLOG",
  kpiBookToBill: "BOOK/BILL",
  kpiNimPercent: "NIM%",
  kpiCet1Percent: "CET1%",
  kpiCombinedRatioPercent: "COMBINED%",
  kpiOccupancyPercent: "OCCUPANCY%",
  kpiLoadFactorPercent: "LOAD FACTOR%",
  guideRevenueChangePercent: "REV GUIDE CHG%",
  guideEpsChangePercent: "EPS GUIDE CHG%",

  price: "PRICE",
  changePercent: "CHG%",
  volume: "VOLUME",
  averageVolume20d: "AVG VOL 20D",
  relativeVolume: "REL VOL",
  marketCap: "MKT CAP",
  trailingPE: "P/E",
  forwardPE: "FWD P/E",
  enterpriseToRevenue: "EV/REV",
  dividendYieldPercent: "DIV YLD%",
  revenueGrowthPercent: "FY REV GR%",
  earningsGrowthPercent: "FY EARN GR%",
  grossMarginPercent: "FY GROSS MGN%",
  operatingMarginPercent: "FY OP MGN%",
  netMarginPercent: "FY NET MGN%",
  shortInterestShares: "SHORT INT",
  shortInterestChangePercent: "SI CHG%",
  daysToCover: "DAYS COVER",
  insiderPurchases90d: "INS BUYS 90D",
  insiderSales90d: "INS SELLS 90D",
  institutionalHolders: "13F HOLDERS",
  institutionalNewHolders: "13F NEW",
  institutionalExits: "13F EXITS",
  xPostsPerDay: "X POSTS/D",
  xPostsVsMedian: "X VS MED",
  wikiViewsPerDay: "WIKI/D",
  wikiViewsVsMedian: "WIKI VS MED",
  attentionResearchUnits: "ATTN HRS",
  attentionZScore: "ATTN Z",
  return1WPercent: "1W%",
  return1MPercent: "1M%",
  return3MPercent: "3M%",
  returnYtdPercent: "YTD%",
  return1YPercent: "1Y%",
  fromHigh52WPercent: "VS 52W HI%",
  beta: "BETA",
  atrPercent: "ATR%",
  priceToBook: "P/B",
  evToEbitda: "EV/EBITDA",
  roePercent: "FY ROE%",
  epsRevision30dPercent: "EPS REV 30D%",
  analystUpsidePercent: "UPSIDE%",
  ivRank: "IV RANK",
  ivToHv: "IV/HV",
  hiringOpenRoles: "OPEN ROLES",
  hiringNetAddsWeek: "NET ROLES/WK",
  hiringRemotePercent: "REMOTE%",
  hiringZScore: "HIRING Z",
  appAttentionScore: "APP SCORE",
  appRankVelocity7d: "APP RANK/D",
  appRatingDrift7d: "RATING 7D",
  appRatingCountGrowth7d: "RATINGS 7D",
};
const COMPACT = new Set<NumericField>(["kpiArr", "kpiRpo", "kpiCrpo", "kpiSubscribers", "kpiDau", "kpiMau", "kpiGmv", "kpiStores", "kpiBacklog", "marketCap", "volume", "averageVolume20d", "shortInterestShares"]);
/** Daily counts: whole numbers below a thousand, compact above. */
const DAILY_COUNTS = new Set<NumericField>(["xPostsPerDay", "wikiViewsPerDay"]);
const RATIOS = new Set<NumericField>(["kpiBookToBill", "xPostsVsMedian", "wikiViewsVsMedian", "priceToBook", "evToEbitda", "ivToHv"]);
const RETURNS: NumericField[] = ["return1WPercent", "return1MPercent", "return3MPercent", "returnYtdPercent", "return1YPercent"];
const SIGNED = new Set<NumericField>(["hiringNetAddsWeek", "hiringZScore", "appRankVelocity7d", "appRatingDrift7d", "appRatingCountGrowth7d",
  "guideRevenueChangePercent", "guideEpsChangePercent", "kpiSameStoreSalesPercent",
  "changePercent", "revenueGrowthPercent", "earningsGrowthPercent", "shortInterestChangePercent",
  ...RETURNS, "fromHigh52WPercent", "epsRevision30dPercent", "analystUpsidePercent",
]);
/** Moves whose sign is the news: they take the sign colour. */
export const SIGN_COLORED = new Set<NumericField>(["changePercent", ...RETURNS, "epsRevision30dPercent", "analystUpsidePercent"]);
const COUNTS = new Set<NumericField>(["appRatingCountGrowth7d", "hiringNetAddsWeek", "hiringOpenRoles", "attentionResearchUnits", "insiderPurchases90d", "insiderSales90d", "institutionalHolders", "institutionalNewHolders", "institutionalExits", "ivRank"]);
const MONETARY = new Set<NumericField>(["price", "marketCap", "kpiArr", "kpiRpo", "kpiCrpo", "kpiGmv", "kpiBacklog"]);
/** Shown after the screen's own criteria when the pane has room. */
const CONTEXT_FIELDS: NumericField[] = ["marketCap", "price", "changePercent", "trailingPE", "revenueGrowthPercent", "operatingMarginPercent", "dividendYieldPercent"];

export function formatScreenValue(field: NumericField, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  if (COMPACT.has(field)) return formatCompact(value, { fixedDecimals: true });
  if (DAILY_COUNTS.has(field)) return value < 1_000 ? value.toFixed(0) : formatCompact(value, { fixedDecimals: true });
  if (RATIOS.has(field)) return `${value.toFixed(1)}x`;
  if (COUNTS.has(field)) return formatNumber(value, 0);
  if (field === "price" || field === "beta") return formatNumber(value, 2);
  // A value that rounds to zero prints 0.0, never -0.0.
  const fixed = Math.abs(value) < 0.05 ? "0.0" : formatNumber(value, 1);
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

/** Prices get room for a separated six-figure quote (757,398.00). */
export const columnWidth = (field: NumericField) => Math.max(field === "price" ? 10 : 8, SHORT_LABELS[field].length);

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
    kpiArr: "Annual recurring revenue",
    kpiNrrPercent: "Net revenue retention %",
    kpiRpo: "Remaining performance obligations",
    kpiCrpo: "Current RPO",
    kpiSubscribers: "Subscribers",
    kpiDau: "Daily active users",
    kpiMau: "Monthly active users",
    kpiGmv: "Gross merchandise value",
    kpiTakeRatePercent: "Take rate %",
    kpiSameStoreSalesPercent: "Same-store sales growth %",
    kpiStores: "Stores",
    kpiBacklog: "Backlog",
    kpiBookToBill: "Book-to-bill",
    kpiNimPercent: "Net interest margin %",
    kpiCet1Percent: "CET1 ratio %",
    kpiCombinedRatioPercent: "Combined ratio %",
    kpiOccupancyPercent: "Occupancy %",
    kpiLoadFactorPercent: "Load factor %",
    guideRevenueChangePercent: "Revenue guide change %",
    guideEpsChangePercent: "EPS guide change %",
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
    xPostsPerDay: "X posts per day",
    xPostsVsMedian: "X posts vs median",
    wikiViewsPerDay: "Wikipedia views per day",
    wikiViewsVsMedian: "Wikipedia views vs median",
    attentionResearchUnits: "Research attention hours (Pro)",
    attentionZScore: "Abnormal research attention (Pro)",
    return1WPercent: "1W return %",
    return1MPercent: "1M return %",
    return3MPercent: "3M return %",
    returnYtdPercent: "YTD return %",
    return1YPercent: "1Y return %",
    fromHigh52WPercent: "From 52-week high %",
    beta: "Beta",
    atrPercent: "ATR%",
    priceToBook: "P/B",
    evToEbitda: "EV / EBITDA",
    roePercent: "Annual ROE %",
    epsRevision30dPercent: "EPS revision 30D %",
    analystUpsidePercent: "Analyst upside %",
    ivRank: "IV rank",
    ivToHv: "IV / HV",
    hiringOpenRoles: "Hiring open roles",
    hiringNetAddsWeek: "Net open roles per week",
    hiringRemotePercent: "Remote roles %",
    hiringZScore: "Hiring z-score",
    appAttentionScore: "App attention score / 100",
    appRankVelocity7d: "App rank places per day, 7D",
    appRatingDrift7d: "App rating drift, 7D",
    appRatingCountGrowth7d: "App ratings added, 7D",
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
/** Insider activity is an observed subset: it can show activity, never prove its absence. */
const OBSERVED_SUBSET_FIELDS: readonly string[] = ["insiderPurchases90d", "insiderSales90d"];
const NUMERIC_OPERATORS: ScreenOperator[] = ["gte", "lte", "gt", "lt", "eq", "between", "present", "missing"];
const OBSERVED_SUBSET_OPERATORS: ScreenOperator[] = ["gte", "gt", "present", "missing"];
const CATEGORY_OPERATORS: ScreenOperator[] = ["in", "present", "missing"];

/** The operators a definition may use on a field, or null for a field screens do not have. */
function screenFieldOperators(field: string): ScreenOperator[] | null {
  if (OBSERVED_SUBSET_FIELDS.includes(field)) return [...OBSERVED_SUBSET_OPERATORS];
  if ((NUMERIC_FIELDS as readonly string[]).includes(field)) return [...NUMERIC_OPERATORS];
  if ((CATEGORY_FIELDS as readonly string[]).includes(field)) return [...CATEGORY_OPERATORS];
  return null;
}

/**
 * The definition format in a paragraph: its parts, and the operators each kind
 * of field takes with the value each operator wants.
 */
export function screenDefinitionSyntax(): string {
  const single = NUMERIC_OPERATORS.filter((op) => !["between", "present", "missing"].includes(op));
  return [
    "JSON screen: version 1, criteria (up to 20 {field, op, value} conditions, [] for none),",
    "sort {field, direction asc|desc} and currency (a three-letter code such as USD, or null when nothing compares money).",
    `Operators by field: numeric fields (the --metric values) take ${single.join(", ")} with one number,`,
    "between with [min, max], present and missing with no value;",
    `${OBSERVED_SUBSET_FIELDS.join(" and ")} take only ${OBSERVED_SUBSET_OPERATORS.join(", ")};`,
    `category fields (${CATEGORY_FIELDS.join(", ")}) take in with an array of 1-25 names, present, missing.`,
  ].join(" ");
}

/** A worked definition: one criterion of each value shape. Tests parse it so it cannot drift from the validator. */
export const EXAMPLE_SCREEN_DEFINITION: ScreenDefinition = {
  version: 1,
  currency: "USD",
  criteria: [
    { field: "industry", op: "in", value: ["Gold"] },
    { field: "marketCap", op: "gte", value: 10_000_000_000 },
    { field: "trailingPE", op: "between", value: [5, 30] },
  ],
  sort: { field: "marketCap", direction: "desc" },
};

const VALUE_SHAPES: Partial<Record<ScreenOperator, string>> = {
  in: "an array of 1-25 names, such as [\"Gold\"]",
  between: "[min, max] in ascending order, such as [5, 30]",
};

function definitionError(part: string, problem: string): Error {
  return new Error(`Invalid screen definition: ${part} ${problem}`);
}

/** One criterion checked and normalized: names trimmed and deduplicated, keys in order. */
function checkCriterion(criterion: unknown, index: number): ScreenCriterion {
  const part = `criteria[${index}]`;
  if (!criterion || typeof criterion !== "object" || Array.isArray(criterion))
    throw definitionError(part, "must be an object {field, op, value}.");
  const item = criterion as { field?: unknown; op?: unknown; value?: unknown };
  const operators = typeof item.field === "string" ? screenFieldOperators(item.field) : null;
  if (!operators)
    throw definitionError(`${part}.field`, item.field === undefined
      ? "is missing."
      : `${JSON.stringify(item.field)} is not a screen field: use a numeric field such as marketCap, or one of ${CATEGORY_FIELDS.join(", ")}.`);
  const named = `${part} (${item.field}):`;
  if (typeof item.op !== "string" || !operators.includes(item.op as ScreenOperator))
    throw definitionError(named, `${item.op === undefined ? "has no op" : `op ${JSON.stringify(item.op)} is not supported`}: ${item.field} takes ${operators.join(", ")}.`);
  const op = item.op as ScreenOperator;
  const hasValue = "value" in item;
  const field = item.field as ScreenCriterion["field"];
  if (op === "present" || op === "missing") {
    if (hasValue) throw definitionError(named, `${op} takes no value.`);
    return { field, op };
  }
  const value = item.value;
  const shape = VALUE_SHAPES[op] ?? "one number, such as 10000000000";
  const valid = op === "in"
    ? Array.isArray(value) && value.length >= 1 && value.length <= 25
      && value.every((entry) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 120)
    : op === "between"
      ? Array.isArray(value) && value.length === 2 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
        && (value[0] as number) <= (value[1] as number)
      : typeof value === "number" && Number.isFinite(value);
  if (!valid) throw definitionError(named, `${op} takes ${shape}${hasValue ? `, not ${JSON.stringify(value)}` : ""}.`);
  if (op === "in")
    return { field: field as (typeof CATEGORY_FIELDS)[number], op, value: [...new Set((value as string[]).map((entry) => entry.trim()))] };
  if (op === "between")
    return { field: field as NumericField, op, value: [(value as number[])[0]!, (value as number[])[1]!] };
  return { field: field as NumericField, op: op as "gte", value: value as number };
}

export function parseScreenDefinition(value: unknown): ScreenDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid screen definition: it must be a JSON object with version, criteria, sort and currency.");
  const item = value as ScreenDefinition;
  const fields = [...NUMERIC_FIELDS, ...CATEGORY_FIELDS] as string[];
  // Every top-level part that is wrong, so one fix does not uncover the next.
  const problems: string[] = [];
  if (item.version !== 1)
    problems.push(`version must be 1${"version" in item ? `, not ${JSON.stringify(item.version)}` : ""}`);
  if (!Array.isArray(item.criteria))
    problems.push(`criteria ${"criteria" in item ? "must be" : "is missing:"} a list of {field, op, value} conditions, [] for none`);
  else if (item.criteria.length > 20)
    problems.push(`criteria holds at most 20 conditions, not ${item.criteria.length}`);
  const sort = item.sort as { field?: unknown; direction?: unknown } | undefined;
  if (!sort || typeof sort !== "object")
    problems.push(`sort ${"sort" in item ? "must be" : "is missing:"} {field, direction} with direction asc or desc`);
  else {
    if (typeof sort.field !== "string" || !fields.includes(sort.field))
      problems.push(`sort.field ${sort.field === undefined ? "is missing" : `${JSON.stringify(sort.field)} is not a screen field`}`);
    if (sort.direction !== "asc" && sort.direction !== "desc")
      problems.push("sort.direction must be asc or desc");
  }
  if (item.currency !== null && (typeof item.currency !== "string" || !/^[A-Z]{3}$/.test(item.currency)))
    problems.push(`currency ${"currency" in item ? `${JSON.stringify(item.currency)} must be` : "is missing:"} a three-letter code such as "USD", or null when nothing compares money`);
  if (problems.length) throw new Error(`Invalid screen definition: ${problems.join("; ")}.`);
  const criteria = item.criteria.map(checkCriterion);
  const money = [item.sort.field, ...criteria.filter((criterion) => "value" in criterion).map((criterion) => criterion.field)]
    .find((field) => MONETARY.has(field as NumericField));
  if (!item.currency && money)
    throw new Error(`Invalid screen definition: currency is null, but ${money} compares money; select one currency, such as "USD".`);
  return { version: 1, currency: item.currency, criteria,
    sort: { field: item.sort.field, direction: item.sort.direction } };
}
const requiredDate = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const validDate = (value: unknown) => value === null || requiredDate(value);
export const screenDefinitionKey = (value: ScreenDefinition) =>
  JSON.stringify(parseScreenDefinition(value));
const unavailableMetric = (): ScreenMetric => ({
  value: null, unit: "", asOf: null, availableAt: null, observedAt: null, source: "Gloom Cloud",
  state: "unavailable", scope: "reported", reason: "Not provided by this server", sourceUrl: null,
  percentile: { value: null, sampleCount: 0, scope: "covered-universe" },
});
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
    throw new Error("Invalid screener response.");
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
      // A server from before social, research or volatility fields omits them; they read as unavailable.
      if (!row.metrics[field] && ([...SOCIAL_FIELDS, ...RESEARCH_FIELDS, ...VOLATILITY_FIELDS, ...ATTENTION_FIELDS, ...HIRING_APP_FIELDS, ...KPI_FIELDS] as readonly string[]).includes(field))
        row.metrics[field] = unavailableMetric();
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
        throw new Error(`Invalid ${field} observation.`);
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
