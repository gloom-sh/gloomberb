import { mapCloudFinancials } from "../sources/gloomberb-cloud/normalizers";

export function scopedFixture() {
  const after = Date.parse("2028-02-18T17:00Z"), before = Date.parse("2028-02-16T17:00Z");
  const scope = { basis: "standalone" as const, entity: "vylor-standalone", registrant: "0002128626", label: "Vylor standalone (as filed)" };
  const end = "2027-12-31", filed = "2028-02-17";
  const quote = { symbol: "VYLR", price: 65, currency: "USD", change: 0, changePercent: 0, lastUpdated: after, listingExchangeName: "NYSE" };
  const quarters = ["03-31", "06-30", "09-30", "12-31"].map((day, index) => ({ date: `2027-${day}`, availableAt: filed,
    currency: "USD", statementScope: scope, eps: [0.75, 0.75, 1, 0.75][index], totalRevenue: 30e6 }));
  const raw = { annualStatements: [{ ...quarters[3]!, eps: 3, availableAt: "2028-02-15" }], quarterlyStatements: quarters,
    priceHistory: [before, after].map(time => ({ date: new Date(time), close: 65 })), financialCurrency: "USD", statementScope: scope,
    statementReview: { status: "reviewed" as const, reviewedThrough: filed }, fundamentals: { eps: 3.25, epsCurrency: "USD", trailingPeriodEnd: end, trailingPE: 20 } };
  return { raw, quarters, scope, end, filed, quote, before, after };
}

export function scopedNyseCloseFixture() {
  const { raw, quarters, quote, filed } = scopedFixture();
  const onFilingDay = (hour: number) => new Date(`${filed}T${String(hour).padStart(2, "0")}:00:00Z`);
  const data = { ...mapCloudFinancials({ ...raw, quarterlyStatements: quarters.map(row => ({ ...row, fieldAvailability: { eps: onFilingDay(17).toISOString() } })) }),
    quote: { ...quote, stale: true }, priceHistory: [
      { date: onFilingDay(0), close: 78 }, { date: onFilingDay(16), close: 65 }, { date: onFilingDay(18), close: 65 },
    ] };
  return { data, onFilingDay };
}
