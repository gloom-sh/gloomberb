import type { GraphPath, GraphPayload } from "../../../api-client/supply-chain-graph";
import type { HeadlessBundleResult, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchSupplyChain } from "./client";
import { evidenceLabel, isUnconfirmed, matchesSupplyOptions, supplyOptions, trustTier } from "./trust";
import { fetchSupplyGraph, graphOptions } from "./graph-client";
import { exposureLabel, pathLabel } from "./graph-model";

const pathColumns = [
  { key: "route", header: "Route" }, { key: "hops", header: "Hops" },
  { key: "score", header: "Rank score", description: "Product of normalized edge weights; not a probability." },
  { key: "confidence", header: "Confidence" }, { key: "exposureLabel", header: "Estimated exposure" },
];
function graphReport(data: GraphPayload, target: string): HeadlessBundleResult {
  const links = new Map(data.links.map(link => [link.id, link]));
  const nodes = new Map(data.nodes.map(node => [node.id, node]));
  const route = (path: GraphPath) => ({ ...path, route: pathLabel(path, data), exposureLabel: exposureLabel(path, data),
    exposure: path.exposure ? { ...path.exposure, denominatorEntity: nodes.get(path.exposure.denominatorEntityId) } : null,
    evidence: path.linkIds.map((id, index) => ({ hop: index + 1, linkId: id, from: nodes.get(path.nodeIds[index]!),
      to: nodes.get(path.nodeIds[index + 1]!), primaryEvidenceId: links.get(id)!.primaryEvidenceId, disclosures: links.get(id)!.evidence })),
  });
  const sections: HeadlessBundleResult["sections"] = target
    ? [{ title: `Routes to ${data.target?.name ?? target}`, columns: pathColumns, rows: data.paths.map(route) }]
    : (["upstream", "downstream", "related"] as const).map(direction => ({
      title: direction === "upstream" ? "Upstream suppliers" : direction === "downstream" ? "Downstream customers" : "Related companies",
      columns: [{ key: "company", header: "Company" }, { key: "ticker", header: "Ticker" }, ...pathColumns],
      rows: data[direction].map(reach => ({ ...route(data.options.ranking === "shortest" ? reach.shortestPath : reach.bestPath), entityId: reach.entityId, company: nodes.get(reach.entityId)?.name,
        ticker: nodes.get(reach.entityId)?.ticker, direction: reach.direction, bestPath: route(reach.bestPath), shortestPath: route(reach.shortestPath) })),
    }));
  sections.push({ title: "Disclosure evidence", columns: [
    { key: "reporter", header: "Reporting company" }, { key: "from", header: "Supplier / from" }, { key: "to", header: "Customer / to" },
    { key: "role", header: "Role" }, { key: "pct", header: "% disclosed" }, { key: "denominator", header: "Denominator" },
    { key: "period", header: "Period" }, { key: "filed", header: "Filed" }, { key: "confidence", header: "Confidence" },
    { key: "quote", header: "Quote" }, { key: "filingUrl", header: "Filing" },
  ], rows: data.links.flatMap(link => link.evidence.map(item => ({ id: item.id, linkId: link.id, primary: item.id === link.primaryEvidenceId,
    reporter: item.reporter.name, from: item.from.name, to: item.to.name, role: item.role, pct: item.pctOfRevenue ?? null,
    denominator: item.pctBasis && !(item.sourceKind === "xbrl" && item.pctScope) ? `${item.reporter.name} ${item.pctBasis}${item.pctScope ? ` (${item.pctScope})` : ""}` : null,
    pctBasis: item.pctBasis, pctScope: item.pctScope, period: item.period, filed: item.filedDate, asOf: item.asOf,
    confidence: item.confidence, quote: item.quote, quoteLanguage: item.quoteLanguage, quoteGloss: item.quoteGloss ?? null,
    quoteGlossKind: item.quoteGloss ? "machine_translation" : null, nativeAmount: item.nativeAmount ?? null,
    nativeCurrency: item.nativeCurrency ?? null, nativeScale: item.nativeScale ?? null, jurisdiction: item.jurisdiction,
    entityScope: item.entityScope ?? null, sectionRef: item.sectionRef ?? null, sourceAttribution: item.sourceAttribution ?? null,
    filingUrl: item.filingUrl, evidence: item,
  }))) });
  const errors = data.search.reasons.map(reason => `Graph search incomplete: ${reason.replaceAll("_", " ")}`);
  if (data.access === "preview") errors.push("Gloom Pro is required for full graph depth and results");
  if (!data.entity) errors.push("The focus company could not be resolved");
  if (target && !data.target) errors.push("The target company could not be resolved");
  if (data.truncated && !errors.length) errors.push("Graph results are truncated");
  return { sections, complete: data.access === "full" && !!data.entity && (!target || !!data.target) && data.search.complete && !data.truncated && data.requestedDepth <= data.maxDepth,
    errors, metadata: { symbol: data.symbol, target: data.target, asOf: data.asOf, snapshotAt: data.snapshotAt,
      access: data.access, requestedDepth: data.requestedDepth, maxDepth: data.maxDepth, options: data.options,
      search: data.search, truncated: data.truncated, methodology: data.methodology, graph: data } };
}

export const supplyChainHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: { source: "Company filings, calls and news", status: "not-a-feed", basis: "disclosed relationships" },
  argument: { kind: "ticker", description: "Company ticker, exchange-qualified ticker, or id:<entity-id>.", placeholder: "ticker" },
  discovery: { aliases: ["SPLC", "SUPPLY"], dataRequirements: ["Gloom Cloud relationship evidence (Pro with free preview)"],
    limitations: ["Filings, company announcements, earnings calls and news where evidence is available globally", "Japan filings await an API key and Taiwan report ingestion is disabled", "English glosses are machine translations, separate from original evidence", "Absence is not proof of no relationship",
      "Table/Flow free preview: three relationships per role in each direction", "Pro: up to four hops; free graph preview: one hop and three results per section", "Reverse percentages belong to the reporting company",
      "Path rank scores are not probabilities; chained percentages are estimates", "Search limits and incomplete reasons accompany every graph report",
      "Unconfirmed leads are opt-in and excluded from flow and disclosed values", "Restricted publisher articles expose links only",
      "Table and Flow evidence tiers differ from Graph and Path evidence tiers"] },
  options: [
    { key: "view", type: "enum", settingKey: "view", defaultValue: "says", values: [{ value: "says" }, { value: "names" }], description: "Statements by the company, or other sources naming it." },
    { key: "tab", type: "enum", settingKey: "tab", defaultValue: "table", values: ["table", "flow", "graph", "path"].map(value => ({ value })), description: "Disclosures table, direct flow, multi-hop graph or routes to a target." },
    { key: "route", type: "integer", minimum: 1, maximum: 50, defaultValue: 1, settingKey: "route", description: "Selected route for graph and evidence screenshots." },
    { key: "evidence", type: "boolean", settingKey: "evidence", defaultValue: false, description: "Open selected relationship or path evidence in screenshots." },
    { key: "depth", type: "integer", settingKey: "depth", minimum: 1, maximum: 4, defaultValue: 2, description: "Maximum graph depth in hops (Pro)." },
    { key: "direction", type: "enum", settingKey: "direction", defaultValue: "both", values: ["upstream", "downstream", "both"].map(value => ({ value })), description: "Follow upstream suppliers, downstream customers, or both." },
    { key: "roles", type: "string", settingKey: "roles", description: "Comma-separated customer,supplier,partner,competitor,investee roles." },
    { key: "sources", type: "string", settingKey: "sources", description: "Comma-separated xbrl,filing_text,press_release,call,news,web,import source kinds." },
    { key: "tiers", type: "string", settingKey: "tiers", description: "Table/Flow: sec (regulatory filings),company,call,reported,unconfirmed (default sec,company,call; unconfirmed opts into leads). Graph/Path: structured,primary,secondary,imported (default all)." },
    { key: "min-pct", type: "string", settingKey: "minPct", defaultValue: "0", description: "Minimum disclosed percentage, 0 to 100; positive thresholds exclude unknown percentages." },
    { key: "min-confidence", type: "string", settingKey: "minConfidence", defaultValue: "0", description: "Minimum edge confidence, 0 to 1." },
    { key: "limit", type: "integer", settingKey: "limit", minimum: 1, maximum: 50, defaultValue: 50, description: "Maximum results per graph section or paths." },
    { key: "ranking", type: "enum", settingKey: "ranking", defaultValue: "score", values: [{ value: "score" }, { value: "shortest" }], description: "Rank paths by edge-weight product or fewest hops." },
    { key: "as-of", type: "string", settingKey: "asOf", description: "Include disclosures known by this date (YYYY-MM-DD)." },
    { key: "to", type: "string", settingKey: "to", description: "Target company ticker or id:<entity-id>; required for Path." },
  ],
  describe: (args) => `Supply chain | ${args.symbols[0]}${args.options.to ? ` → ${args.options.to}` : ""}`,
  async load(args, ctx) {
    if (args.options.tab === "graph" || args.options.tab === "path") {
      const target = String(args.options.to ?? "").trim();
      if (args.options.tab === "path" && !target) throw new Error("Path requires a target company: --to TICKER");
      return graphReport(await fetchSupplyGraph(args.symbols[0]!, graphOptions(args.options), target, ctx.apiClient), target);
    }
    const options = supplyOptions(args.options.tiers);
    const data = await fetchSupplyChain(args.symbols[0]!, ctx.apiClient, options);
    return { complete: !data.truncated, errors: data.truncated ? ["Additional relationships need Gloom Pro"] : [],
      sections: (["says", "names"] as const).flatMap((view) => [false, true].map((leads) => ({ title: `${view === "says" ? `${data.symbol} says` : `Names ${data.symbol}`}${leads ? " | Unconfirmed" : ""}`,
        rows: data[view].filter((row) => matchesSupplyOptions(row, options) && isUnconfirmed(row) === leads).map((row) => ({ counterparty: row.counterparty.name, ticker: row.counterparty.ticker, aggregate: row.counterparty.aggregate, role: row.role, direction: row.direction,
          pct: row.pctOfRevenue, pctBasis: row.pctBasis, pctScope: row.pctScope, usd: row.usd, usdBasis: row.usdBasis, period: row.period, fiscalYear: row.fiscalYear,
          nativeAmount: row.nativeAmount ?? null, nativeCurrency: row.nativeCurrency ?? null, nativeScale: row.nativeScale ?? null,
          jurisdiction: row.jurisdiction ?? null, entityScope: row.entityScope ?? null,
          evidenceTier: evidenceLabel(row), tier: trustTier(row), claimType: row.claimType, corroboration: row.corroboration ?? 1,
          leadStatus: row.leadStatus ?? "none", whyUnconfirmed: row.whyUnconfirmed ?? null,
          firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, lastConfirmedAt: row.lastConfirmedAt,
          source: row.sourceKind, filed: row.filedDate, confidence: row.confidence, reportingCompany: row.reportingEntity.name,
          quote: row.quote, quoteLanguage: row.quoteLanguage, quoteGloss: row.quoteGloss ?? null, quoteGlossKind: row.quoteGloss ? "machine_translation" : null,
          quoteMatchMode: row.quoteMatchMode, sourceUrl: row.filingUrl, filingUrl: row.filingUrl, sectionRef: row.sectionRef ?? null, sourceAttribution: row.sourceAttribution ?? null,
          evidence: row.evidence ?? [] })) })).filter((section) => section.rows.length > 0)),
      metadata: { symbol: data.symbol, asOf: data.asOf, counts: data.counts, tierCounts: data.tierCounts, tiers: options.tiers, disclaimer: data.disclaimer } };
  },
};
