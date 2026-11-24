import type { SupplyDirectory, SupplyDirectoryEntry } from "../../../api-client/supply-chain";

export function directoryRows(report: SupplyDirectory) {
  return report.entries.map((entry, index) => ({
    ...entry, id: report.sha256 + ":" + index, buyer: report.buyer, buyerListing: report.buyerListing,
    effectiveDay: report.effectiveDay, observedAt: report.observedAt, sourceUrl: report.url,
  }));
}

export function directoryColumns(rows: readonly SupplyDirectoryEntry[]) {
  const fields = [
    ["operator", "Named operator", 34], ["kind", "Role", 20], ["buyer", "Reporting company", 22],
    ["parent", "Reported parent", 27], ["country", "Country", 16], ["city", "City", 16],
    ["effectiveDay", "List date", 12], ["observedAt", "Observed", 12],
  ] as const;
  return fields.filter(([key]) => !["parent", "country", "city"].includes(key)
    || rows.some(row => row[key as "parent" | "country" | "city"]));
}
