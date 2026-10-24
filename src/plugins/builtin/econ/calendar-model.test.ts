import { afterEach, describe, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import type { EconEvent } from "./types";
import {
  attachEconCalendarPersistence,
  calendarDisplayRows,
  hasPendingHighImpactPrint,
  landedHighImpactPrints,
  loadCalendar,
  countriesWithoutEvents,
  eventCountry,
  matchesCountry,
  matchesImpact,
  noScheduledReleasesMessage,
  parseCountryFilter,
  pendingHighImpactPrints,
  resetEconCalendarPersistence,
  actualColor,
  valueColumnWidth,
} from "./calendar-model";
import { colors } from "../../../theme/colors";

function makeEvent(id: string): EconEvent {
  return {
    id,
    date: new Date("2026-05-24T13:30:00.000Z"),
    time: "08:30",
    country: "US",
    event: "Core PCE Price Index",
    impact: "high",
    actual: null,
    forecast: "0.3%",
    prior: "0.2%",
  };
}

afterEach(() => {
  resetEconCalendarPersistence();
});

describe("econ calendar cache", () => {
  test("rehydrates persisted events without refetching", async () => {
    const persistence = new MemoryPluginPersistence();
    attachEconCalendarPersistence(persistence);

    await loadCalendar(false, async () => [makeEvent("pce")]);

    resetEconCalendarPersistence();
    attachEconCalendarPersistence(persistence);

    let calls = 0;
    const result = await loadCalendar(false, async () => {
      calls += 1;
      return [makeEvent("fallback")];
    });

    expect(calls).toBe(0);
    expect(result.data.map((event) => event.id)).toEqual(["pce"]);
    expect(result.data[0]!.date).toBeInstanceOf(Date);
    expect(result.stale).toBe(false);
  });

  test("marks a failed refresh stale instead of passing the cache off as fresh", async () => {
    const persistence = new MemoryPluginPersistence();
    attachEconCalendarPersistence(persistence);
    await loadCalendar(false, async () => [makeEvent("pce")]);

    const result = await loadCalendar(true, async () => {
      throw new Error("calendar endpoint down");
    });

    expect(result.data.map((event) => event.id)).toEqual(["pce"]);
    expect(result.stale).toBe(true);
    expect(result.refreshError).toContain("calendar endpoint down");
  });
});

describe("econ calendar filters", () => {
  test("each impact level selects only its own events", () => {
    const low = { ...makeEvent("low"), impact: "low" as const };
    const high = makeEvent("high");
    expect(matchesImpact(low, "low")).toBe(true);
    expect(matchesImpact(high, "low")).toBe(false);
    expect(matchesImpact(high, "all")).toBe(true);
  });

  test("G7 covers every member, not just the ones with a cached flag", () => {
    for (const country of ["US", "GB", "FR", "DE", "IT", "JP", "CA", "EU"]) {
      expect(matchesCountry({ ...makeEvent(country), country }, "G7")).toBe(true);
    }
    expect(matchesCountry({ ...makeEvent("cn"), country: "CN" }, "G7")).toBe(false);
  });
});

describe("high-impact prints", () => {
  const release = new Date("2026-10-14T12:30:00.000Z").getTime();

  test("a blank high-impact row is pending only after it is due", () => {
    const cpi = { ...makeEvent("cpi"), date: new Date(release) };
    expect(hasPendingHighImpactPrint([cpi], release - 1)).toBe(false);
    expect(hasPendingHighImpactPrint([cpi], release + 60_000)).toBe(true);
    expect(hasPendingHighImpactPrint([cpi], release + 21 * 60_000)).toBe(false);
    expect(hasPendingHighImpactPrint([{ ...cpi, impact: "low" }], release + 60_000)).toBe(false);
    expect(hasPendingHighImpactPrint([{ ...cpi, actual: "0.3%" }], release + 60_000)).toBe(false);
  });

  // They never get an actual: waiting on one would poll every client for 20 minutes after each,
  // from midnight UTC for a bank's untimed decision.
  test("a central bank decision or a statistics office's listed release is never a pending print", () => {
    const midnight = new Date("2026-10-22T00:00:00.000Z").getTime();
    const decision = {
      ...makeEvent("cb-cbrt-2026-10-22"), date: new Date(midnight), time: "All Day", country: "TR",
      event: "CBRT Interest Rate Decision", kind: "central-bank-decision" as const, timeNote: "The bank's calendar gives the day, not the time",
    };
    const release12 = { ...makeEvent("inegi-10506"), date: new Date(release), country: "MX", event: "Mid-Month CPI", kind: "statistics-release" as const };
    expect(pendingHighImpactPrints([decision], midnight + 60_000)).toEqual([]);
    expect(pendingHighImpactPrints([release12], release + 60_000)).toEqual([]);
    // A feed's own row at the same time still is.
    const feed = { ...makeEvent("cpi"), date: new Date(release) };
    expect(pendingHighImpactPrints([decision, release12, feed], release + 60_000).map((event) => event.id)).toEqual(["cpi"]);
    // Nor is a feed's all-day event (the US midterms), which prints nothing.
    const election = { ...makeEvent("midterms"), date: new Date(midnight), time: "All Day", event: "Midterm Elections" };
    expect(pendingHighImpactPrints([election], midnight + 60_000)).toEqual([]);
  });

  test("a print lands when a blank high-impact actual gets a number", () => {
    const prior = new Map<string, string | null>([["cpi", null], ["claims", "197K"]]);
    const next = [
      { ...makeEvent("cpi"), actual: "0.3%" },
      { ...makeEvent("claims"), actual: "190K", impact: "medium" as const },
      { ...makeEvent("pce"), actual: "0.2%" },
      { ...makeEvent("gdp"), actual: "2.1%" },
    ];
    expect(landedHighImpactPrints(prior, next).map((event) => event.id)).toEqual(["cpi"]);
  });
});

describe("calendar rows", () => {
  // Rows group by UTC day, so the times are UTC whatever zone the tests run in.
  const utc = (day: number, hour: number) => new Date(Date.UTC(2026, 8, day, hour));
  const at = (id: string, day: number, hour: number): EconEvent => ({ ...makeEvent(id), date: utc(day, hour) });
  const layout = (events: EconEvent[], now: Date) => calendarDisplayRows(events, now.getTime())
    .map((row) => row.kind === "event" ? row.event.id : row.kind === "now" ? "NOW" : row.label.split(" · ")[0]);

  test("reads forward in time with NOW under today's header before the next release", () => {
    const events = [at("mon-9", 28, 9), at("mon-16", 28, 16), at("tue-1", 29, 1)];
    expect(layout(events, utc(28, 12))).toEqual(["TODAY", "mon-9", "NOW", "mon-16", "TOMORROW", "tue-1"]);
  });

  test("puts NOW above the next day's header when nothing is left today", () => {
    const events = [at("mon-9", 28, 9), at("mon-16", 28, 16), at("tue-1", 29, 1)];
    expect(layout(events, utc(28, 20))).toEqual(["TODAY", "mon-9", "mon-16", "NOW", "TOMORROW", "tue-1"]);
  });
});

describe("country filters", () => {
  test("take regions and ISO country codes in any case, comma or space separated, once each", () => {
    expect(parseCountryFilter("mx")).toEqual({ filter: "MX" });
    expect(parseCountryFilter("MX,BR,ZA,IN,KR")).toEqual({ filter: "MX,BR,ZA,IN,KR" });
    expect(parseCountryFilter(" mx, br  za,MX ")).toEqual({ filter: "MX,BR,ZA" });
    expect(parseCountryFilter("g7,mx")).toEqual({ filter: "G7,MX" });
    expect(parseCountryFilter("UK")).toEqual({ filter: "GB" });
    expect(parseCountryFilter("eu")).toEqual({ filter: "EU" });
    // All of anything is all.
    expect(parseCountryFilter("MX,all")).toEqual({ filter: "all" });
  });

  test("refuse what is not a country: three letters, an unassigned code, CLDR's unknown region, nothing", () => {
    expect(parseCountryFilter("TUR")).toEqual({ error: 'Unknown country "TUR".' });
    expect(parseCountryFilter("MX,XQ")).toEqual({ error: 'Unknown country "XQ".' });
    expect(parseCountryFilter("ZZ")).toEqual({ error: 'Unknown country "ZZ".' });
    expect(parseCountryFilter(" , ")).toEqual({ error: "No country given." });
  });

  test("a list matches any of its parts, a region its members", () => {
    const at = (country: string) => ({ country, event: "CPI" });
    expect(matchesCountry(at("BR"), "MX,BR")).toBe(true);
    expect(matchesCountry(at("US"), "MX,BR")).toBe(false);
    expect(matchesCountry(at("JP"), "G7,MX")).toBe(true);
    expect(matchesCountry(at("MX"), "G7,MX")).toBe(true);
    expect(matchesCountry(at("TR"), "G7,MX")).toBe(false);
    expect(matchesCountry(at("TR"), "all")).toBe(true);
  });

  test("countries named with nothing listed are said plainly; regions are never among them", () => {
    const events = [{ country: "MX", event: "CPI" }, { country: "US", event: "CPI" }];
    expect(countriesWithoutEvents("MX,BR,ZA", events)).toEqual(["BR", "ZA"]);
    expect(countriesWithoutEvents("G7,IN", events)).toEqual(["IN"]);
    expect(countriesWithoutEvents("US", events)).toEqual([]);
    expect(noScheduledReleasesMessage(["MX"])).toBe("No scheduled releases for MX in this window.");
    expect(noScheduledReleasesMessage(["ZA", "IN"])).toBe("No scheduled releases for ZA or IN in this window.");
    expect(noScheduledReleasesMessage(["MX", "BR", "ZA", "IN", "KR"])).toBe("No scheduled releases for MX, BR, ZA, IN or KR in this window.");
  });

  test("a national euro-area release is its member's by the adjective its title starts with, and still the euro area's", () => {
    // Titles as both feeds list them under EU.
    const eu = (event: string) => ({ country: "EU", event });
    const shown = (event: string) => eventCountry(eu(event));
    expect(shown("German Ifo Business Climate")).toBe("DE");
    expect(shown("German Bundesbank President Nagel Speech")).toBe("DE");
    expect(shown("French GDP Growth Rate QoQ Prel")).toBe("FR");
    expect(shown("Italian 2-Year BTP Short Term Auction")).toBe("IT");
    expect(shown("Spanish Unemployment Rate")).toBe("ES");
    expect(shown("Belgian NBB Business Climate")).toBe("BE");
    // The euro area's own releases, and words that only look like a member's.
    for (const event of ["ECB Interest Rate Decision", "ECB President Lagarde Speech", "Inflation Rate YoY Final", "EU-Bonds Auction",
      "European Commission Forecasts", "Germany 10-Year Bund Yield", "german Ifo Business Climate", "GermanIfo"]) {
      expect([event, shown(event)]).toEqual([event, "EU"]);
    }
    // Only an EU row is read: a German-named row of another country stays that country's.
    expect(eventCountry({ country: "US", event: "German Ifo Business Climate" })).toBe("US");

    const ifo = eu("German Ifo Business Climate");
    expect(matchesCountry(ifo, "EU")).toBe(true);
    expect(matchesCountry(ifo, "G7")).toBe(true);
    expect(matchesCountry(ifo, "DE")).toBe(true);
    expect(matchesCountry(ifo, "FR")).toBe(false);
    expect(matchesCountry(eu("ECB Interest Rate Decision"), "DE")).toBe(false);
    expect(countriesWithoutEvents("DE,FR,EU", [ifo])).toEqual(["FR"]);
  });
});

describe("econ calendar energy units", () => {
  const energy = (actual: string | null, forecast: string | null, prior: string | null): EconEvent => ({
    ...makeEvent("eia"), event: "Crude Oil Inventories", actual, forecast, prior,
  });

  test("a value column widens to keep a unit whole, and keeps its usual width otherwise", () => {
    expect(valueColumnWidth([makeEvent("pce")], "actual", 9)).toBe(9);
    expect(valueColumnWidth([makeEvent("pce"), energy("-3.061M bbl", "-1.2M bbl", "0.034M b/d")], "actual", 9)).toBe(11);
    expect(valueColumnWidth([energy(null, null, "0.034M b/d")], "prior", 9)).toBe(10);
    expect(valueColumnWidth([energy("77 Bcf", "80 Bcf", "67 Bcf")], "forecast", 10)).toBe(10);
    // A long text value does not take the table.
    expect(valueColumnWidth([energy("not published this week", null, null)], "actual", 9)).toBe(12);
  });

  test("a figure with its unit still compares with its forecast", () => {
    expect(actualColor("77 Bcf", "80 Bcf")).toBe(colors.negative);
    expect(actualColor("-3.061M bbl", "-4.000M bbl")).toBe(colors.positive);
    expect(actualColor("0.034M b/d", "0.034M b/d")).toBe(colors.text);
  });
});
