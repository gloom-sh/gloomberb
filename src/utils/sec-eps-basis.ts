/** Keep this pure SEC projection rule synchronized with the cloud backend. */
export interface SecEpsSplitEvidence {
  date: string;
  ratio: number;
  accessionNumber: string;
  filed: string;
  comparativePeriodEnd?: string;
  beforeAccessionNumber?: string;
  beforeEps?: number;
  afterEps?: number;
}

export interface SecEpsBasis {
  status: "split-adjusted" | "unresolved";
  source: "sec";
  originalValue: number;
  originalFiled?: string;
  basisDate: string;
  factor?: number;
  evidence: SecEpsSplitEvidence[];
}

type Fact = { start?: string; end?: string; val?: number; accn?: string; filed?: string; form?: string };
type Row = Fact & { start: string; end: string; val: number; accn: string; filed: string };
type Edge = { node: string; factor: number; evidence?: SecEpsSplitEvidence };
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function entries(payload: unknown, tag: string, unit: string): Fact[] {
  const values = record(record(record(record(record(payload).facts)["us-gaap"])[tag]).units)[unit];
  return Array.isArray(values) ? values.map(record).filter((row) => typeof row.val === "number" && Number.isFinite(row.val)
    && date(row.end) && date(row.filed) && /^(10-K|10-Q)(\/A)?$/.test(String(row.form))
    && /^\d{10}-\d{2}-\d{6}$/.test(String(row.accn))) as Fact[] : [];
}

function uniqueObservations(rows: Fact[]): Map<string, Row> {
  const result = new Map<string, Row>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    if (!date(row.start) || !row.end || row.start > row.end || row.filed! < row.end) continue;
    const key = `${row.accn}:${row.start}:${row.end}`;
    if (result.has(key) && result.get(key)!.val !== row.val) ambiguous.add(key);
    result.set(key, row as Row);
  }
  for (const key of ambiguous) result.delete(key);
  return result;
}

/**
 * Share bases belong to source accessions, not filing dates. A split edge needs
 * an explicit SEC split fact and unchanged same-period income with inverse EPS
 * restatement. Repeated EPS AND diluted shares connect otherwise equal bases.
 * No price jump, ticker exception, or chronological assumption establishes one.
 */
export function createSecEpsBasisResolver(payload: unknown): (fact: Fact) => { value?: number; basis?: SecEpsBasis; availableAt?: string } {
  const splits = entries(payload, "StockholdersEquityNoteStockSplitConversionRatio1", "pure")
    .filter((row) => row.val! > 0 && row.val !== 1)
    .sort((a, b) => a.filed!.localeCompare(b.filed!));
  if (splits.length === 0) return (fact) => ({ value: fact.val, availableAt: fact.filed });
  const eventRows = new Map<string, Fact>();
  const conflicts = new Set<string>();
  for (const split of splits) {
    if (eventRows.has(split.end!) && eventRows.get(split.end!)!.val !== split.val) conflicts.add(split.end!);
    if (!eventRows.has(split.end!)) eventRows.set(split.end!, split);
  }
  const latest = [...eventRows.values()].sort((a, b) => a.end!.localeCompare(b.end!)).at(-1)!;
  const eps = uniqueObservations(entries(payload, "EarningsPerShareDiluted", "USD/shares"));
  const shares = uniqueObservations(entries(payload, "WeightedAverageNumberOfDilutedSharesOutstanding", "shares"));
  const income = uniqueObservations(entries(payload, "NetIncomeLoss", "USD"));
  const graph = new Map<string, Edge[]>();
  const connect = (before: string, after: string, ratio: number, evidence?: SecEpsSplitEvidence) => {
    graph.set(after, [...graph.get(after) ?? [], { node: before, factor: ratio, evidence }]);
    graph.set(before, [...graph.get(before) ?? [], { node: after, factor: 1 / ratio, evidence }]);
  };
  const identical = new Map<string, Row>();
  const periods = new Map<string, Row[]>();
  for (const [key, row] of eps) {
    const period = `${row.start}:${row.end}`;
    periods.set(period, [...periods.get(period) ?? [], row]);
    const denominator = shares.get(key)?.val;
    if (!row.val || !denominator || denominator <= 0) continue;
    const identity = `${period}:${row.val}:${denominator}`;
    const prior = identical.get(identity);
    if (prior && prior.accn !== row.accn) connect(prior.accn, row.accn, 1);
    else identical.set(identity, row);
  }
  const proved = new Map<string, SecEpsSplitEvidence>();
  for (const split of eventRows.values()) {
    if (conflicts.has(split.end!)) continue;
    for (const after of eps.values()) {
      if (after.accn !== split.accn || after.filed !== split.filed || after.end >= split.end! || after.val === 0) continue;
      for (const before of periods.get(`${after.start}:${after.end}`) ?? []) {
        if (before.accn === after.accn || before.filed >= after.filed || before.val === after.val || before.val * after.val <= 0) continue;
        const beforeIncome = income.get(`${before.accn}:${before.start}:${before.end}`)?.val;
        const afterIncome = income.get(`${after.accn}:${after.start}:${after.end}`)?.val;
        if (beforeIncome === undefined || beforeIncome === 0 || beforeIncome !== afterIncome) continue;
        // EPS reports rounded to cents have overlapping rounding intervals.
        // This accommodates 11.91 / 4 -> 2.98 without inventing precision.
        const tolerance = .005 + .005 / split.val!;
        if (Math.abs(before.val / split.val! - after.val) > tolerance + 1e-12
          || Math.abs(before.val - after.val) <= tolerance * 2) continue;
        const evidence: SecEpsSplitEvidence = {
          date: split.end!, ratio: split.val!, accessionNumber: split.accn!, filed: split.filed!,
          comparativePeriodEnd: before.end, beforeAccessionNumber: before.accn, beforeEps: before.val, afterEps: after.val,
        };
        connect(before.accn, after.accn, split.val!, evidence);
        proved.set(split.end!, evidence);
      }
    }
  }
  const paths = new Map<string, { factor: number; evidence: SecEpsSplitEvidence[] }>();
  const queue = [latest.accn!];
  paths.set(latest.accn!, { factor: 1, evidence: [] });
  let inconsistent = false;
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    const path = paths.get(node)!;
    for (const edge of graph.get(node) ?? []) {
      const factor = path.factor * edge.factor;
      if (!Number.isFinite(factor) || factor <= 0) { inconsistent = true; continue; }
      const previous = paths.get(edge.node);
      if (previous) {
        if (Math.abs(previous.factor - factor) > Math.max(previous.factor, factor) * 1e-10) inconsistent = true;
        continue;
      }
      paths.set(edge.node, { factor, evidence: [...path.evidence, ...edge.evidence ? [edge.evidence] : []] });
      queue.push(edge.node);
    }
  }
  return (fact) => {
    if (!fact.end || fact.end >= latest.end!) return { value: fact.val, availableAt: fact.filed };
    const path = fact.accn ? paths.get(fact.accn) : undefined;
    const target = proved.get(latest.end!);
    const evidence = [...new Map([...(path?.evidence ?? []), target ?? {
      date: latest.end!, ratio: latest.val!, accessionNumber: latest.accn!, filed: latest.filed!,
    }].map((item) => [item.date, item])).values()].sort((a, b) => a.date.localeCompare(b.date));
    const basis: SecEpsBasis = {
      status: "unresolved", source: "sec", originalValue: fact.val!, originalFiled: fact.filed,
      basisDate: latest.end!, evidence,
    };
    // Any unproved intervening disclosure can represent an additional share basis.
    const unproved = [...eventRows.values()].some((event) => event.end! > fact.end! && !proved.has(event.end!));
    if (!path || !target || inconsistent || unproved || !date(fact.filed)) return { basis };
    const value = fact.val! / path.factor;
    if (!Number.isFinite(value)) return { basis };
    return {
      value, basis: { ...basis, status: "split-adjusted", factor: path.factor },
      availableAt: [fact.filed, ...evidence.map((item) => item.filed)].sort().at(-1),
    };
  };
}
