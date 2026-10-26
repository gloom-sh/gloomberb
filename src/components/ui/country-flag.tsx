import { createElement, type CSSProperties } from "react";
import { useUiCapabilities } from "../../ui";
import type { DataTableCell } from "./data-table";
import { FLAG_ART, FLAG_HEIGHT, FLAG_WIDTH } from "./country-flag-art";

export interface CountryFlagProps {
  /** ISO 3166 region, or `EU` for the euro area. Anything not drawn renders nothing. */
  region: string | null | undefined;
  /**
   * Keep the flag's room, blank, for a region with no art: a column of
   * countries keeps its text in line whether or not each row has a flag.
   */
  reserve?: boolean;
}

const FLAG_STYLE = {
  display: "block",
  flex: "none",
  width: "calc(var(--cell-w, 8px) * 2.25)",
  height: "calc(var(--cell-w, 8px) * 1.5)",
} as const;

/**
 * A small flag, 2.25 grid cells wide, for the desktop and the web. Decoration
 * only: it is hidden from assistive technology, so the label beside it stays
 * the name. The terminal draws nothing.
 */
export function CountryFlag({ region, reserve = false }: CountryFlagProps) {
  const desktop = useUiCapabilities().nativePaneChrome === true;
  return desktop ? flagArt(region, reserve, FLAG_STYLE) : null;
}

function flagArt(region: string | null | undefined, reserve: boolean, style: CSSProperties) {
  const art = region ? FLAG_ART[region] : undefined;
  if (!art) return reserve ? <svg aria-hidden="true" focusable="false" data-gloom-role="country-flag-room" style={style} /> : null;
  return (
    <svg
      viewBox={`0 0 ${FLAG_WIDTH} ${FLAG_HEIGHT}`}
      aria-hidden="true"
      focusable="false"
      data-gloom-role="country-flag"
      data-region={region}
      style={{ ...style, borderRadius: 2, overflow: "hidden" }}
    >
      {art}
      <rect
        x=".5" y=".5" width={FLAG_WIDTH - 1} height={FLAG_HEIGHT - 1} rx="3"
        fill="none" stroke="#000" strokeOpacity=".28" vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** A table cell's flag sits this far from its text; a flag before any other label keeps the same gap. */
const LEAD_STYLE = { ...FLAG_STYLE, marginRight: "var(--gloom-space-xs)" } as const;

/**
 * The flag of the country `value` names, before a label outside a table: a
 * field's value, a bar's label, a heading. It keeps the gap a table cell's
 * flag has. `reserve` keeps the room, blank, for a value with no flag, so a
 * list's labels stay in line. The terminal draws nothing.
 */
export function CountryFlagLead({ value, reserve = false }: { value: string | null | undefined; reserve?: boolean }) {
  const desktop = useUiCapabilities().nativePaneChrome === true;
  return desktop ? flagArt(flagRegion(value), reserve, LEAD_STYLE) : null;
}

/**
 * The cells a flag and the gap after it take at the start of a table cell. A
 * column sized for its text widens by this on the desktop, where the flag is
 * drawn, so the text keeps its room.
 */
export const COUNTRY_FLAG_CELLS = 3;

/** A column of countries, widened on the desktop by the flag that leads each. */
export function withFlagRoom<C extends { width: number }>(column: C, desktop: boolean): C {
  return desktop ? { ...column, width: column.width + COUNTRY_FLAG_CELLS } : column;
}

/** The euro area, as sources write it. */
const EURO_AREA = new Set(["EU", "EA", "EMU", "EZ", "EUR", "EUROZONE", "EURO AREA", "EURO ZONE", "EUROPEAN UNION"]);

/**
 * What sources call a country when it is not its English name: alpha-3
 * codes, short and old names. Only regions with a flag are listed.
 */
const REGION_ALIASES: Readonly<Record<string, string>> = {
  UK: "GB", GBR: "GB", "GREAT BRITAIN": "GB", BRITAIN: "GB", ENGLAND: "GB",
  USA: "US", "U.S.": "US", "UNITED STATES OF AMERICA": "US",
  JPN: "JP", CHE: "CH", CAN: "CA", AUS: "AU", NZL: "NZ", SWE: "SE", NOR: "NO", DNK: "DK", HKG: "HK", SGP: "SG",
  CHN: "CN", "MAINLAND CHINA": "CN", "CHINA (MAINLAND)": "CN", "PEOPLE'S REPUBLIC OF CHINA": "CN",
  KOR: "KR", KOREA: "KR", "REPUBLIC OF KOREA": "KR", "KOREA, SOUTH": "KR", "KOREA, REPUBLIC OF": "KR",
  TWN: "TW", "TAIWAN, CHINA": "TW", IND: "IN", IDN: "ID", MYS: "MY", PHL: "PH", THA: "TH", VNM: "VN", "VIET NAM": "VN", PAK: "PK",
  POL: "PL", CZE: "CZ", "CZECH REPUBLIC": "CZ", HUN: "HU", ROU: "RO", UKR: "UA", TUR: "TR", TURKEY: "TR", "TÜRKIYE": "TR", TURKIYE: "TR",
  KAZ: "KZ", ISR: "IL", SAU: "SA", ARE: "AE", UAE: "AE", QAT: "QA", EGY: "EG", ZAF: "ZA", NGA: "NG", KEN: "KE",
  MEX: "MX", BRA: "BR", COL: "CO", CHL: "CL", PER: "PE", ARG: "AR",
  DEU: "DE", FRA: "FR", ITA: "IT", ESP: "ES", NLD: "NL", HOLLAND: "NL", "THE NETHERLANDS": "NL", BEL: "BE", AUT: "AT", IRL: "IE",
  PRT: "PT", FIN: "FI", GRC: "GR", LUX: "LU", ISL: "IS", EST: "EE", LVA: "LV", LTU: "LT", BGR: "BG",
  RUS: "RU", "RUSSIAN FEDERATION": "RU", BHR: "BH", CIV: "CI", "IVORY COAST": "CI", "COTE D'IVOIRE": "CI", "CÔTE D'IVOIRE": "CI",
  "HONG KONG": "HK", "HONG KONG SAR": "HK", DOM: "DO", PAN: "PA", KWT: "KW", IRN: "IR", IRAN: "IR", "IRAN, ISLAMIC REPUBLIC OF": "IR", IRQ: "IQ", VEN: "VE", VENEZUELA: "VE",
  BEN: "BJ", BOL: "BO", BOLIVIA: "BO", ETH: "ET", HND: "HN", PRY: "PY", UGA: "UG", UZB: "UZ",
  TUN: "TN", MAR: "MA", CRI: "CR",
};

let regionCodes: Map<string, string> | null = null;

/** English names of every region with a flag, from the runtime's region names. */
function namedRegions(): Map<string, string> {
  if (regionCodes) return regionCodes;
  regionCodes = new Map();
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
    for (const code of Object.keys(FLAG_ART)) {
      const name = names.of(code);
      if (name) regionCodes.set(name.toUpperCase().replaceAll("’", "'"), code);
    }
  } catch {
    // Intentional ignore: without region names, codes and the aliases above still resolve.
  }
  return regionCodes;
}

/**
 * The region whose flag stands for `value`, as a pane shows it: an ISO 3166
 * alpha-2 or alpha-3 code (`GB`, `GBR`, `UK`), the euro area (`EU`, `EA`,
 * "Euro area"), or the country's English name ("United Kingdom", "Korea").
 * Null for anything with no flag: a region, a city, several countries.
 */
export function flagRegion(value: string | null | undefined): string | null {
  const key = value?.trim().toUpperCase();
  if (!key) return null;
  if (EURO_AREA.has(key)) return "EU";
  const code = REGION_ALIASES[key] ?? (/^[A-Z]{2}$/.test(key) ? key : namedRegions().get(key.replaceAll("’", "'")) ?? null);
  return code && FLAG_ART[code] ? code : null;
}

/**
 * A table cell led by the flag of the country `value` names, through the
 * cell's `leading`, on the desktop and the web. The terminal's cell comes
 * back as it was, so its output does not change. A value with no flag keeps
 * the flag's room, blank, so a column's text stays in line; widen the column
 * by `COUNTRY_FLAG_CELLS` on the desktop.
 */
export function withCountryFlag(cell: DataTableCell, value: string | null | undefined, desktop: boolean): DataTableCell {
  if (!desktop) return cell;
  return { ...cell, leading: createElement(CountryFlag, { region: flagRegion(value), reserve: true }) };
}
