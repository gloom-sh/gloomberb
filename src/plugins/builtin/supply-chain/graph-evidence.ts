import type { SupplyRow } from "../../../api-client/supply-chain";
import type { GraphEvidence } from "../../../api-client/supply-chain-graph";

/** Graph classes describe extraction format; source trust is a separate numeric tier. */
export function graphEvidenceRow(evidence: GraphEvidence): SupplyRow {
  return {
    id: evidence.id, counterparty: evidence.reporter.id === evidence.to.id ? evidence.from : evidence.to,
    reportingEntity: evidence.reporter, role: evidence.role,
    direction: evidence.role === "supplier" ? "in" : evidence.role === "customer" ? "out" : "mutual",
    sourceKind: evidence.sourceKind, period: evidence.period, asOf: evidence.asOf,
    fiscalYear: evidence.fiscalYear ?? null, form: evidence.form ?? null, filedDate: evidence.filedDate ?? null,
    pctOfRevenue: evidence.pctOfRevenue ?? null, pctBasis: evidence.pctBasis ?? null, pctScope: evidence.pctScope ?? null,
    usd: evidence.usd ?? null, usdBasis: evidence.usdBasis ?? null,
    nativeAmount: evidence.nativeAmount ?? null, nativeCurrency: evidence.nativeCurrency ?? null, nativeScale: evidence.nativeScale ?? null,
    jurisdiction: evidence.jurisdiction, entityScope: evidence.entityScope,
    confidence: evidence.confidence, quote: evidence.quote, quoteLanguage: evidence.quoteLanguage ?? null,
    quoteGloss: evidence.quoteGloss, sectionRef: evidence.sectionRef, sourceAttribution: evidence.sourceAttribution,
    quoteMatchMode: evidence.quoteMatchMode ?? null, filingUrl: evidence.filingUrl, accession: evidence.accession ?? null,
    tier: evidence.trustTier ?? (evidence.sourceKind === "xbrl" || evidence.sourceKind === "filing_text" ? 1
      : evidence.sourceKind === "press_release" ? 2 : evidence.sourceKind === "call" ? 3 : 4),
    claimType: evidence.claimType, corroboration: evidence.corroboration, leadStatus: evidence.leadStatus,
    firstSeenAt: evidence.firstSeenAt, lastSeenAt: evidence.lastSeenAt, lastConfirmedAt: evidence.lastConfirmedAt,
    whyUnconfirmed: evidence.whyUnconfirmed, evidence: evidence.evidence,
  };
}
