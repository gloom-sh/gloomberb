/** Keep this pure SEC projection rule synchronized with the cloud backend. */
interface SecEpsSplitEvidence {
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
type Proof = { split: Fact; before: Row; after: Row; evidence: SecEpsSplitEvidence };
type SplitEvent = { ratio: number; proofs: Proof[]; consistent: boolean; evidence: SecEpsSplitEvidence; node: string };
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

/** When the last restated filing and the first restating one were filed: the split falls between. */
function cut(proofs: Proof[]): { lastRestated: string; firstRestating: string } {
  return {
    lastRestated: proofs.reduce((max, proof) => proof.before.filed > max ? proof.before.filed : max, ""),
    firstRestating: proofs.reduce((min, proof) => proof.after.filed < min ? proof.after.filed : min, "9999"),
  };
}
const separable = (proofs: Proof[]) => cut(proofs).lastRestated < cut(proofs).firstRestating;

/**
 * One split, however many filings repeat it and under whatever context dates
 * (an approval date, the effective date, each period of the equity statement).
 * Rows with one ratio and one context date are one disclosure. A split divides
 * the filings once, so disclosures with one ratio are one split when a single
 * filing date still separates every filing they restate from every filing that
 * restates; two splits with one ratio leave no such date (the later split
 * restates filings that already carry the earlier one).
 */
function splitEvents(proofs: Proof[]): SplitEvent[] {
  const disclosures = new Map<string, Proof[]>();
  for (const proof of proofs) {
    const key = `${proof.split.val}:${proof.split.end}`;
    disclosures.set(key, [...disclosures.get(key) ?? [], proof]);
  }
  const groups: Proof[][] = [];
  for (const ratio of new Set(proofs.map((proof) => proof.split.val!))) {
    const sorted = [...disclosures.values()].filter((group) => group[0]!.split.val === ratio)
      .sort((a, b) => cut(a).firstRestating.localeCompare(cut(b).firstRestating) || cut(a).lastRestated.localeCompare(cut(b).lastRestated));
    let current: Proof[] = [];
    for (const disclosure of sorted) {
      // A disclosure whose own filings admit no such date proves nothing.
      if (!separable(disclosure)) groups.push(disclosure);
      else if (current.length && separable([...current, ...disclosure])) current.push(...disclosure);
      else {
        current = [...disclosure];
        groups.push(current);
      }
    }
  }
  return groups.map((group, index) => {
    const first = [...group].sort((a, b) => a.after.filed.localeCompare(b.after.filed) || a.after.accn.localeCompare(b.after.accn)
      || a.split.end!.localeCompare(b.split.end!) || a.before.filed.localeCompare(b.before.filed) || a.before.end.localeCompare(b.before.end))[0]!;
    return { ratio: group[0]!.split.val!, proofs: group, consistent: separable(group), evidence: first.evidence, node: `split:${index}` };
  });
}

/**
 * Share bases belong to source accessions, not filing dates. A split edge needs
 * an explicit SEC split fact and unchanged same-period income with inverse EPS
 * restatement. Repeated EPS AND diluted shares connect otherwise equal bases;
 * where a filing tags no diluted shares, repeated EPS AND income do, if no
 * disclosed split could leave that EPS unchanged at cent rounding.
 * No price jump, ticker exception, or chronological assumption establishes one.
 *
 * Every filing that states a split and restates an earlier filing by its ratio
 * is evidence of that split. The filings it restated share one basis and the
 * restating filings share the next, so a split filed in several filings under
 * several context dates is one factor, not a run of unproved disclosures.
 */
export function createSecEpsBasisResolver(payload: unknown): (fact: Fact) => { value?: number; basis?: SecEpsBasis; availableAt?: string } {
  const splits = entries(payload, "StockholdersEquityNoteStockSplitConversionRatio1", "pure")
    .filter((row) => row.val! > 0 && row.val !== 1)
    .sort((a, b) => a.filed!.localeCompare(b.filed!));
  if (splits.length === 0) return (fact) => ({ value: fact.val, availableAt: fact.filed });
  // A filing that gives one split context two ratios contradicts itself.
  const stated = new Map<string, number>();
  const contradicted = new Set<string>();
  for (const split of splits) {
    const context = `${split.accn}:${split.end}`;
    if (stated.has(context) && stated.get(context) !== split.val) contradicted.add(context);
    stated.set(context, split.val!);
  }
  const latest = [...splits].sort((a, b) => b.end!.localeCompare(a.end!))[0]!;
  const eps = uniqueObservations(entries(payload, "EarningsPerShareDiluted", "USD/shares"));
  const shares = uniqueObservations(entries(payload, "WeightedAverageNumberOfDilutedSharesOutstanding", "shares"));
  const income = uniqueObservations(entries(payload, "NetIncomeLoss", "USD"));
  const key = (row: Fact) => `${row.accn}:${row.start}:${row.end}`;
  const graph = new Map<string, Edge[]>();
  const connect = (before: string, after: string, ratio: number, evidence?: SecEpsSplitEvidence) => {
    graph.set(after, [...graph.get(after) ?? [], { node: before, factor: ratio, evidence }]);
    graph.set(before, [...graph.get(before) ?? [], { node: after, factor: 1 / ratio, evidence }]);
  };
  const identical = new Map<string, Row>();
  const periods = new Map<string, Row[]>();
  for (const row of eps.values()) {
    const period = `${row.start}:${row.end}`;
    periods.set(period, [...periods.get(period) ?? [], row]);
    const denominator = shares.get(key(row))?.val;
    if (!row.val || !denominator || denominator <= 0) continue;
    const identity = `${period}:${row.val}:${denominator}`;
    const prior = identical.get(identity);
    if (prior && prior.accn !== row.accn) connect(prior.accn, row.accn, 1);
    else identical.set(identity, row);
  }
  // Not every filer tags diluted shares (Alphabet before 2024). Where a filing
  // tags none for the period, a repeated EPS and net income connect instead,
  // when no disclosed split ratio could leave that EPS unchanged at cent
  // rounding. Diluted shares that differ still keep the bases apart.
  const ratios = [...new Set(splits.map((split) => split.val!))];
  const telling = (value: number) => ratios.every((ratio) => Math.abs(value - value / ratio) > .005 + .005 / ratio
    && Math.abs(value - value * ratio) > .005 + .005 * ratio);
  const tagged = new Set(entries(payload, "WeightedAverageNumberOfDilutedSharesOutstanding", "shares").map(key));
  for (const rows of periods.values()) {
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const [a, b] = [rows[i]!, rows[j]!];
        if (a.accn === b.accn || a.val !== b.val || !a.val || !telling(a.val)) continue;
        if (tagged.has(key(a)) && tagged.has(key(b))) continue;
        const repeated = income.get(key(a))?.val;
        if (repeated !== undefined && repeated !== 0 && repeated === income.get(key(b))?.val) connect(a.accn, b.accn, 1);
      }
    }
  }
  // A later filing restates an earlier one's EPS for the same period by the
  // ratio, with income unchanged.
  const restates = (before: Row, after: Row, ratio: number) => {
    if (before.accn === after.accn || before.filed >= after.filed || before.val === after.val || before.val * after.val <= 0) return false;
    const beforeIncome = income.get(key(before))?.val;
    const afterIncome = income.get(key(after))?.val;
    if (beforeIncome === undefined || beforeIncome === 0 || beforeIncome !== afterIncome) return false;
    // EPS reports rounded to cents have overlapping rounding intervals.
    // This accommodates 11.91 / 4 -> 2.98 without inventing precision.
    const tolerance = .005 + .005 / ratio;
    return Math.abs(before.val / ratio - after.val) <= tolerance + 1e-12 && Math.abs(before.val - after.val) > tolerance * 2;
  };
  const proofs: Proof[] = [];
  for (const split of splits) {
    if (contradicted.has(`${split.accn}:${split.end}`)) continue;
    for (const after of eps.values()) {
      if (after.accn !== split.accn || after.filed !== split.filed || after.end >= split.end! || after.val === 0) continue;
      for (const before of periods.get(`${after.start}:${after.end}`) ?? []) {
        if (!restates(before, after, split.val!)) continue;
        proofs.push({ split, before, after, evidence: {
          date: split.end!, ratio: split.val!, accessionNumber: split.accn!, filed: split.filed!,
          comparativePeriodEnd: before.end, beforeAccessionNumber: before.accn, beforeEps: before.val, afterEps: after.val,
        } });
      }
    }
  }
  const events = splitEvents(proofs);
  const consistent = events.filter((event) => event.consistent);
  // The filings a split restated share one basis and its restating filings the
  // next. Evidence that mixes splits only connects the two filings it compares.
  const eventOf = new Map<Fact, SplitEvent>();
  for (const event of events) {
    if (!event.consistent) {
      for (const proof of event.proofs) connect(proof.before.accn, proof.after.accn, event.ratio, proof.evidence);
      continue;
    }
    connect(`${event.node}:before`, `${event.node}:after`, event.ratio, event.evidence);
    for (const proof of event.proofs) {
      connect(proof.before.accn, `${event.node}:before`, 1);
      connect(`${event.node}:after`, proof.after.accn, 1);
      eventOf.set(proof.split, event);
    }
  }
  // A filing that repeats a proved split's restatement without stating its
  // ratio (a 10-K after the split's 10-Qs) restates on that split when exactly
  // one split fits: the restated filing before the split's first restating
  // filing, the restating one after its last restated filing, and a period
  // before the split's context dates.
  const known = new Set([...proofs.flatMap((proof) => [proof.before.accn, proof.after.accn]),
    ...splits.filter((split) => contradicted.has(`${split.accn}:${split.end}`)).map((split) => split.accn!)]);
  for (const after of eps.values()) {
    if (known.has(after.accn) || after.val === 0) continue;
    for (const before of periods.get(`${after.start}:${after.end}`) ?? []) {
      const fits = consistent.filter((event) => restates(before, after, event.ratio)
        && before.filed < cut(event.proofs).firstRestating && after.filed > cut(event.proofs).lastRestated
        && event.proofs.some((proof) => after.end < proof.split.end!));
      if (fits.length !== 1) continue;
      connect(before.accn, `${fits[0]!.node}:before`, 1);
      connect(`${fits[0]!.node}:after`, after.accn, 1);
    }
  }
  // A row that proves nothing itself repeats a proved split: the same ratio at
  // the context date of a row that proves it, or else stated in one of that
  // split's filings. Only an unambiguous match counts.
  const proving = new Set(proofs.map((proof) => proof.split));
  for (const split of splits) {
    if (proving.has(split) || contradicted.has(`${split.accn}:${split.end}`)) continue;
    const candidates = consistent.filter((event) => event.ratio === split.val);
    const dated = candidates.filter((event) => event.proofs.some((proof) => proof.split.end === split.end));
    const filed = candidates.filter((event) => event.proofs.some((proof) => proof.before.accn === split.accn || proof.after.accn === split.accn));
    const match = dated.length ? dated : filed;
    if (match.length === 1) eventOf.set(split, match[0]!);
  }
  // The latest disclosed split sets the current basis. Its filings must also be
  // the latest restating filings, or the disclosures and the filings disagree.
  const target = eventOf.get(latest);
  let inconsistent = !!target && events.some((event) => event.consistent && event !== target
    && cut(event.proofs).firstRestating >= cut(target.proofs).firstRestating);
  const paths = new Map<string, { factor: number; evidence: SecEpsSplitEvidence[] }>();
  const queue = target ? [`${target.node}:after`] : [];
  if (target) paths.set(queue[0]!, { factor: 1, evidence: [] });
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
    const evidence = [...new Map([...(path?.evidence ?? []), target?.evidence ?? {
      date: latest.end!, ratio: latest.val!, accessionNumber: latest.accn!, filed: latest.filed!,
    }].map((item) => [item.date, item])).values()].sort((a, b) => a.date.localeCompare(b.date));
    const basis: SecEpsBasis = {
      status: "unresolved", source: "sec", originalValue: fact.val!, originalFiled: fact.filed,
      basisDate: latest.end!, evidence,
    };
    // Any unproved intervening disclosure can represent an additional share basis.
    const unproved = splits.some((split) => split.end! > fact.end! && !eventOf.has(split));
    if (!path || !target || inconsistent || unproved || !date(fact.filed)) return { basis };
    const value = fact.val! / path.factor;
    if (!Number.isFinite(value)) return { basis };
    return {
      value, basis: { ...basis, status: "split-adjusted", factor: path.factor },
      availableAt: [fact.filed, ...evidence.map((item) => item.filed)].sort().at(-1),
    };
  };
}
