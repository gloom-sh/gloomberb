/** Cache reuse policy for one Equity Diagnostic request. */
export type CloudEquityDiagnosticMode = "cache-first" | "refresh";

export type CloudEquityDiagnosticFindingKind =
  "red_flag" | "green_flag" | "anomaly";

/** 3 is the most severe. */
type CloudEquityDiagnosticSeverity = 1 | 2 | 3;

export interface CloudEquityDiagnosticFinding {
  id: string;
  kind: CloudEquityDiagnosticFindingKind;
  severity: CloudEquityDiagnosticSeverity;
  confidence: number;
  title: string;
  /** What the data says, with no reading attached. */
  observation: string;
  /** What the observation may mean; kept apart from the observation on purpose. */
  interpretation: string;
  /** Ids into `evidence`; unresolved ids are dropped by the client. */
  evidenceIds: string[];
}

export interface CloudEquityDiagnosticCoverage {
  dataset: string;
  status: "available" | "no_data" | "unsupported" | "failed";
  asOf?: string;
  provider?: string;
  note?: string;
}

/** The server owns citation URLs; the client never builds them. */
export interface CloudEquityDiagnosticEvidence {
  id: string;
  dataset: string;
  label: string;
  asOf?: string;
  provider?: string;
  url?: string;
}

interface CloudEquityDiagnosticPending {
  status: "generating";
  retryAfterMs: number;
}

export interface CloudEquityDiagnosticResponse {
  schemaVersion: 1;
  access: "preview" | "full";
  symbol: string;
  exchange: string;
  companyName?: string;
  status: "complete" | "partial" | "insufficient_data";
  verdict: "risk_skewed" | "balanced" | "opportunity_skewed" | "unclear";
  summary: string;
  confidence: number;
  findings: CloudEquityDiagnosticFinding[];
  watchItems: string[];
  coverage: CloudEquityDiagnosticCoverage[];
  evidence: CloudEquityDiagnosticEvidence[];
  generatedAt: string;
  expiresAt: string;
  /** Before this instant a `refresh` request may still answer from cache. */
  refreshAllowedAt: string;
  cached: boolean;
  stale: boolean;
  promptVersion: 1;
  /** The model that answered. Diagnostic only: never rendered to the user. */
  model: string;
}

export type CloudEquityDiagnosticResult =
  CloudEquityDiagnosticPending | CloudEquityDiagnosticResponse;
