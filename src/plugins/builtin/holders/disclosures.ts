import type { OwnershipDisclosure, OwnershipDisclosures } from "../../../api-client/ownership-disclosures";
import type { HeadlessPaneColumn } from "../../../types/plugin";

const columns = [
  ["owner", "Holder", 22], ["date", "Date", 10], ["dateBasis", "Date basis", 10], ["kind", "Disclosure", 22],
  ["role", "Role / filing type", 18], ["position", "Position", 12], ["securities", "Securities", 15], ["percent", "Held %", 8],
  ["involved", "Shares involved", 16], ["change", "Change", 13],
  ["pledged", "Pledged", 13], ["direct", "Direct", 15], ["deemed", "Deemed", 15],
] as const;
export function disclosureColumns(rows: OwnershipDisclosure[]) {
  return columns.filter(([key]) => !["position", "involved", "percent", "change", "pledged", "direct", "deemed"].includes(key) || rows.some(row => row[key] != null));
}

export function disclosureWarnings(payload: OwnershipDisclosures) {
  const warnings = payload.registers.filter(register => register.status !== "read").map(register => {
    const name = register.kind === "major" ? "Major shareholder disclosures"
      : register.kind === "major-notices" ? "Major shareholder notices" : "Insider disclosures";
    return register.status === "unavailable" ? name + " unavailable." : name + " from the saved read on " + register.retrievedAt?.slice(0, 10) + ".";
  });
  const pending = payload.registers.reduce((total, register) => total + (register.pending ?? 0), 0);
  const unreadable = payload.registers.reduce((total, register) => total + (register.unreadable ?? 0), 0);
  if (pending) warnings.push(`${pending} SGX ${pending === 1 ? "notice" : "notices"} pending.`);
  if (unreadable) warnings.push(`${unreadable} SGX ${unreadable === 1 ? "notice" : "notices"} could not be fully read.`);
  return warnings;
}

export function disclosureEmpty(payload: OwnershipDisclosures) {
  return payload.listing.endsWith(":SGX")
    ? "No SGX ownership notices in the past year."
    : "No ownership disclosures in the published registers.";
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
    ...(!payload.rows.length ? {empty: warnings.length ? warnings.join(" ") : disclosureEmpty(payload)} : {}),
  };
}
