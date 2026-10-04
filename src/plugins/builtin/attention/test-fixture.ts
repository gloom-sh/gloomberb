import type { AttentionPayload, AttentionRow } from "../../../api-client/attention";
/** Isolated visual/contract fixtures. These are never shipped as a collected dataset. */
export function attentionFixture(overrides: Partial<AttentionPayload> = {}): AttentionPayload {
  const names = [["6758:JPX", "6758", "JPX", "Sony Group", "JP", "Consumer Discretionary"], ["NVDA", "NVDA", "NASDAQ", "NVIDIA", "US", "Information Technology"],
    ["ASML:AEB", "ASML", "AEB", "ASML Holding", "NL", "Information Technology"], ["2330:TWSE", "2330", "TWSE", "Taiwan Semiconductor", "TW", "Information Technology"],
    ["SAP:IBIS", "SAP", "IBIS", "SAP", "DE", "Information Technology"], ["7203:JPX", "7203", "JPX", "Toyota Motor", "JP", "Consumer Discretionary"]];
  const rows = names.map(([symbol, ticker, exchange, name, country, sector], i): AttentionRow => ({
    symbol: symbol!, ticker: ticker!, exchange: exchange!, name: name!, country: country!, sector: sector!, rank: i + 1,
    researchUnits: 320 - i * 35, sharePct: [25, 22, 18, 14, 12, 9][i]!, zScore: i === 5 ? null : 4.2 - i * .7, baselinePeriods: i === 5 ? 7 : 22,
    priceChangePct: 1.25 - i * .9, relativeVolume: 2.1 - i * .15, marketAsOf: "2026-10-02T15:00:00Z", relativeVolumeAsOf: "2026-10-02T14:00:00Z",
    news: [{ title: "Fixture headline: quarterly business update", url: "https://example.com/fixture-business-update", publishedAt: "2026-10-02T13:00:00Z" }],
    history: Array.from({ length: i === 5 ? 42 : 672 }, (_, j) => ({ bucketStart: new Date(Date.parse(i === 5 ? "2026-10-01T00:00:00Z" : "2026-09-04T18:00:00Z") + j * 3_600_000).toISOString(), researchUnits: Math.max(20, Math.round(((320 - i * 35) * (0.5 + Math.sin(j / 22) * .13)) / 5) * 5), publishedAt: new Date(Date.parse(i === 5 ? "2026-10-01T02:00:00Z" : "2026-09-04T20:00:00Z") + j * 3_600_000).toISOString(), minimumContributors: 20, rounding: 5, lagHours: 1, methodologyVersion: 1 })),
    evidence: { source: "Gloom opt-in research counts", asOf: "2026-10-02T19:00:00Z", periodStart: "2026-10-02T17:00:00Z", periodEnd: "2026-10-02T18:00:00Z", unit: "rounded researcher-hours", confidence: "privacy-thresholded", methodologyVersion: 1 },
  }));
  const total = rows.reduce((sum, row) => sum + row.researchUnits, 0);
  for (const row of rows) {
    row.history.at(-1)!.researchUnits = row.researchUnits;
    row.sharePct = row.researchUnits / total * 100;
    const latest = Date.parse(row.history.at(-1)!.bucketStart);
    const baseline = row.history.filter((point) => Date.parse(point.bucketStart) < latest && (latest - Date.parse(point.bucketStart)) % 86_400_000 === 0).map((point) => point.researchUnits);
    row.baselinePeriods = baseline.length;
    const mean = baseline.reduce((sum, value) => sum + value, 0) / baseline.length;
    const std = Math.sqrt(baseline.reduce((sum, value) => sum + (value - mean) ** 2, 0) / baseline.length);
    row.zScore = baseline.length >= 14 && std > 0 ? (row.researchUnits - mean) / std : null;
  }
  const groups = (field: "sector" | "country") => [...new Set(rows.map((row) => row[field]!))].map((name) => {
    const subset = rows.filter((row) => row[field] === name);
    const researchUnits = subset.reduce((sum, row) => sum + row.researchUnits, 0);
    return { name, researchUnits, sharePct: researchUnits / total * 100, tickers: subset.length };
  }).sort((a, b) => b.researchUnits - a.researchUnits);
  return { generatedAt: "2026-10-02T19:01:00Z", asOf: "2026-10-02T19:00:00Z", window: "now", periodStart: "2026-10-02T17:00:00Z", periodEnd: "2026-10-02T18:00:00Z",
    status: "ready", stale: false, rows,
    sectors: groups("sector"), countries: groups("country"),
    privacy: { minimumContributors: 20, rounding: 5, lagHours: 1, methodologyVersion: 1 }, coverage: { publishedHours: 560, publishedTickers: 6, baselineDays: 28 },
    methodologyUrl: "https://github.com/gloom-sh/gloomberb/blob/main/docs/research-attention.md", entitlement: "pro", truncated: false,
    counts: { rows: 6, sectors: 2, countries: 5 }, ...overrides };
}
export function attentionPreview(): AttentionPayload {
  const full = attentionFixture();
  return { ...full, entitlement: "preview", truncated: true, rows: full.rows.slice(0, 3).map((row) => ({ ...row, history: row.history.slice(-1) })), countries: full.countries.slice(0, 3) };
}
