import type { OwnershipDisclosure, OwnershipDisclosures } from "../../../api-client/ownership-disclosures";
import type { HeadlessPaneColumn } from "../../../types/plugin";

const columns = [
  ["owner", "Holder", 22], ["date", "Date", 10], ["dateBasis", "Date basis", 10], ["kind", "Disclosure", 22],
  ["role", "Role / filing type", 18], ["position", "Position", 12], ["securities", "Securities", 15], ["percent", "Held %", 8],
  ["involved", "Shares involved", 16], ["change", "Change", 13],
  ["pledged", "Pledged", 13],
] as const;
export function disclosureColumns(rows: OwnershipDisclosure[]) {
  return columns.filter(([key]) => !["position", "involved", "percent", "change", "pledged"].includes(key) || rows.some(row => row[key] != null));
}

export function disclosureWarnings(payload: OwnershipDisclosures) {
  return payload.registers.filter(register => register.status !== "read").map(register => {
    const name = register.kind === "major" ? "Major shareholder disclosures"
      : register.kind === "major-notices" ? "Major shareholder notices" : "Insider disclosures";
    return register.status === "unavailable" ? name + " unavailable." : name + " from the saved read on " + register.retrievedAt?.slice(0, 10) + ".";
  });
}
export function disclosureReport(payload: OwnershipDisclosures) {
  const warnings = disclosureWarnings(payload);
  const columns: HeadlessPaneColumn[] = disclosureColumns(payload.rows).map(([key, header]) => ({ key, header }));
  return {
    columns: [...columns, {key: "url", header: "Source document"}], textColumns: columns,
    rows: payload.rows.map(row => ({...row})), rowAsOfKey: "date",
    metadata: {
      listing: payload.listing, publisher: payload.publisher, registers: payload.registers,
      total: payload.total, shown: payload.rows.length, truncated: payload.rows.length < payload.total,
    },
    freshness: {source: payload.publisher, status: "not-a-feed" as const, basis: "ownership disclosures", asOf: payload.rows[0]?.date ?? null, oldest: null},
    ...(warnings.length ? {warnings, complete: false} : {}),
    ...(!payload.rows.length ? {empty: warnings.length ? warnings.join(" ") : "No ownership disclosures in the published registers."} : {}),
  };
}
