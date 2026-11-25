import { afterEach, expect, setSystemTime, test } from "bun:test";
import { resetGeoCatalogCache } from "../../../api-client/geo";
import { createTestHeadlessArgs, createTestHeadlessContext, createTestTemplateContext } from "../../../test-support/headless";
import { createGeoFixtureRequest } from "../../../test-support/test-fixture-geo";
import type { HeadlessPaneContext } from "../../../types/headless";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { mapHeadless } from "./headless";
import { worldVenueMapModule } from "./index";
import { buildMapSettingsDef, HOME_AREA_SETTING_KEY } from "./layers";
import { nextVenueExceptions, venueExceptionLines } from "./venue-exceptions";

afterEach(() => resetGeoCatalogCache());

const apiClient = { geo: createGeoFixtureRequest() } as unknown as HeadlessPaneContext["apiClient"];

test("a layer's entity table reports plain values and its linked tickers", async () => {
  const result = await mapHeadless.load(
    createTestHeadlessArgs({ options: { layer: "chokepoints", query: "strait", limit: 100 } }),
    createTestHeadlessContext({ apiClient }),
  );
  expect(result.columns?.map((column) => column.key)).toEqual([
    "label", "transits", "transits7dAvg", "transitsChgPct", "tankers7dAvg", "containers7dAvg", "dryBulk7dAvg", "capacityT7dAvg", "lastDay",
    "ticker", "lon", "lat",
  ]);
  const hormuz = result.rows.find((row) => row.label === "Strait of Hormuz")!;
  expect(hormuz.transits).toBe(4);
  // Percentage points stay plain numbers: -13.6 is -13.6%.
  expect(hormuz.transitsChgPct).toBe(-13.6);
  expect(hormuz.ticker).toBe("XOM:XNYS");
  expect(hormuz.tickers).toBe("XOM:XNYS, CVX:XNYS, FRO:XNYS");
  expect(result.rows.every((row) => String(row.label).includes("Strait"))).toBe(true);
  expect(result.metadata).toMatchObject({ layer: "chokepoints", cadence: "daily", status: "ok" });
});

test("a group typed after MAP opens its layers, and an unknown layer names the known ones", async () => {
  const template = worldVenueMapModule.paneTemplates!.find((entry) => entry.id === "world-venue-map-pane")!;
  expect(await template.createInstance!(createTestTemplateContext(), { arg: "energy" })).toMatchObject({ settings: { layers: ["energy"], venues: false } });
  expect(await template.createInstance!(createTestTemplateContext(), {})).toEqual({ placement: "floating" });

  const energy = await mapHeadless.load(createTestHeadlessArgs({ options: { limit: 5 } }), createTestHeadlessContext({ apiClient, settings: { layers: ["energy"] } }));
  expect(energy.metadata).toMatchObject({ layer: "pipelines", otherLayers: ["oil-gas-fields", "terminals"] });
  await expect(mapHeadless.load(createTestHeadlessArgs({ options: { layer: "ufo" } }), createTestHeadlessContext({ apiClient })))
    .rejects.toThrow('No map layer "ufo". Layers: chokepoints, ports, airports');
});

test("a layer reports the status its cadence implies, and a layer that cannot serve claims none", async () => {
  const freshness = async (layer: string) => (
    await mapHeadless.load(createTestHeadlessArgs({ options: { layer } }), createTestHeadlessContext({ apiClient }))
  ).freshness;
  expect(await freshness("vessels")).toEqual({ status: "live" });
  expect(await freshness("chokepoints")).toMatchObject({ status: "not-a-feed", basis: "daily data" });
  expect(await freshness("airports")).toMatchObject({ status: "not-a-feed", basis: "reference data" });
  // An unavailable live layer has no rows to call live; its error says why.
  expect(await freshness("flights")).toBeUndefined();
});

test("a new map keeps only the place that was typed: the home area is read when the map opens, and clearing it restores world", async () => {
  const template = worldVenueMapModule.paneTemplates!.find((entry) => entry.id === "world-venue-map-pane")!;
  const context = createTestHeadlessContext();
  context.config.pluginConfig["market-overview"] = { [HOME_AREA_SETTING_KEY]: "51.5,-0.1" };
  const templateContext = createTestTemplateContext({ config: context.config });
  for (const arg of ["ships", undefined]) {
    const made = await template.createInstance!(templateContext, arg ? { arg } : {});
    expect(JSON.stringify(made)).not.toContain("51.5");
    expect(made!.settings ?? {}).not.toHaveProperty("place");
  }
  expect(await template.createInstance!(templateContext, { arg: "ships" })).toMatchObject({ title: "Map · Ships", settings: { layers: ["ships"] } });
  expect(await template.createInstance!(templateContext, { arg: "air Sydney" })).toMatchObject({ title: "Map · Air · Sydney", settings: { place: "Sydney", layers: ["air"] } });
  expect(buildMapSettingsDef({}, null).fields.find((field) => field.key === HOME_AREA_SETTING_KEY)).toMatchObject({ storage: "plugin" });
  context.config.pluginConfig["market-overview"]![HOME_AREA_SETTING_KEY] = "";
  expect(await template.createInstance!(templateContext, {})).toEqual({ placement: "floating" });
});

test("headless places bound and order the table; an unknown place reports once and returns the world", async () => {
  const paths: string[] = [];
  const client = { geo: createGeoFixtureRequest({ onRequest: (path) => paths.push(path) }) } as unknown as HeadlessPaneContext["apiClient"];
  const context = createTestHeadlessContext({ apiClient: client });
  const args = createTestHeadlessArgs({ argument: "ships Suez Canal" });
  const near = await mapHeadless.load(args, context);
  expect(near.metadata?.place).toMatchObject({ label: "Suez Canal" });
  expect(near.rows.map((row) => row.label)).toEqual(["Suez Canal"]);
  expect(paths.some((path) => path.includes("bbox="))).toBe(true);
  expect(mapHeadless.describe(args, near)).toContain("near Suez Canal");
  const unknown = await mapHeadless.load(createTestHeadlessArgs({ argument: "ships Atlantis" }), context);
  expect(unknown.errors).toEqual(['Unknown place "Atlantis"; showing world.']);
  expect(unknown.rows.length).toBeGreaterThan(1);
  context.config.pluginConfig["market-overview"] = { [HOME_AREA_SETTING_KEY]: "30,32" };
  const home = await mapHeadless.load(createTestHeadlessArgs({ argument: "ships" }), context);
  expect(home.metadata?.place).toMatchObject({ latitude: 30, longitude: 32 });
  const coordinates = await mapHeadless.load(createTestHeadlessArgs({ argument: "ships 26.5,56.3" }), context);
  expect(coordinates.metadata?.place).toMatchObject({ latitude: 26.5, longitude: 56.3 });
});

test("the venue list says each venue's session as the service read it from the exchange's calendar", async () => {
  const venue = (mic: string, extra: object) => ({
    mic, name: mic, title: mic, country: "Somewhere", countryCode: "XX", city: "City", timezone: "UTC", latitude: 0, longitude: 0, isOpen: false, ...extra,
  });
  const client = {
    geo: createGeoFixtureRequest(),
    getCloudWorldVenues: async () => ({
      data: {
        providerId: "gloomberb-cloud", checkedAt: 0, refreshAt: 0,
        venues: [
          venue("XRIS", { session: "holiday" }), venue("XNAS", { session: "pre-market" }), venue("ARCX", { session: "after-hours" }),
          // An older service sends the core session alone.
          venue("XLON", { isOpen: true }), venue("XZAG", {}),
        ],
      },
    }),
  } as unknown as HeadlessPaneContext["apiClient"];
  const result = await mapHeadless.load(createTestHeadlessArgs({ argument: "venues" }), createTestHeadlessContext({ apiClient: client }));
  expect(result.columns?.find((column) => column.key === "session")?.header).toBe("Session");
  expect(Object.fromEntries(result.rows.map((row) => [row.mic, [row.session, row.open]]))).toEqual({
    XRIS: ["holiday", false], XNAS: ["pre-market", false], ARCX: ["after-hours", false], XLON: ["open", true], XZAG: ["closed", false],
  });
  // `--limit` keeps the nearest venues and says how many there were, as each layer's page does.
  const cut = await mapHeadless.load(createTestHeadlessArgs({ argument: "venues", options: { limit: 2 } }), createTestHeadlessContext({ apiClient: client }));
  expect(cut.rows.map((row) => row.mic)).toEqual(result.rows.slice(0, 2).map((row) => row.mic));
  expect(cut.notes).toEqual(["first 2 of 5 rows (--limit 2)"]);
  expect(result.notes).toEqual([]);
});

test("a venue says when it next opens or closes, as the pane's header does, and the footer and JSON read one stale flag", async () => {
  // XLON on Sat 21 Nov 2026 at 19:06 UTC, read a minute earlier: it opens Mon 08:00 UTC.
  const checkedAt = Date.parse("2026-11-21T19:05:00Z");
  setSystemTime(new Date("2026-11-21T19:06:00Z"));
  try {
    const read = (stale?: boolean) => ({
      geo: createGeoFixtureRequest(),
      getCloudWorldVenues: async () => ({
        data: {
          providerId: "gloomberb-cloud", checkedAt, refreshAt: checkedAt + 60_000, ...stale ? { stale } : {},
          venues: [{ mic: "XLON", name: "XLON", title: "LONDON STOCK EXCHANGE", country: "United Kingdom", countryCode: "GB", city: "London",
            timezone: "Europe/London", latitude: 51.5, longitude: -0.13, isOpen: false, session: "closed", timeToOpenSeconds: 132_900 }],
        },
      }),
    }) as unknown as HeadlessPaneContext["apiClient"];
    const args = createTestHeadlessArgs({ argument: "venues" });
    const result = await mapHeadless.load(args, createTestHeadlessContext({ apiClient: read() }));
    expect(result.rows[0]).toMatchObject({ nextChange: "opens", nextChangeAt: "2026-11-23T08:00:00.000Z", nextText: "opens 36h 54m" });
    expect(renderHeadlessPaneText(mapHeadless, result, args, "MAP")).toMatch(/XLON .* closed +19:06 +opens 36h 54m\n/);
    expect(result.metadata).toMatchObject({ stale: false });
    // A payload the service marks stale says so in its metadata, which the footer reads.
    const stale = await mapHeadless.load(args, createTestHeadlessContext({ apiClient: read(true) }));
    expect(stale.metadata).toMatchObject({ stale: true });
    expect(renderHeadlessPaneText(mapHeadless, stale, args, "MAP")).toMatch(/· stale/);
  } finally {
    setSystemTime();
  }
});

test("Thanksgiving closure and early close are separate from the NYSE clock and fit a narrow header", async () => {
  const now = Date.parse("2026-11-25T16:00:00Z");
  setSystemTime(now);
  try {
    const client = { ...apiClient, getCloudWorldVenues: async () => ({ data: { checkedAt: now, venues: [{ mic: "XNYS",
      title: "NYSE", country: "United States", city: "New York", timezone: "America/New_York", latitude: 40.7, longitude: -74,
      isOpen: true, session: "open", timeToCloseSeconds: 18_000 }] } }) } as unknown as HeadlessPaneContext["apiClient"];
    const args = createTestHeadlessArgs({ argument: "venues", options: { query: "XNYS" } });
    const report = await mapHeadless.load(args, createTestHeadlessContext({ apiClient: client }));
    expect(report.rows[0]).toMatchObject({ nextChangeAt: "2026-11-25T21:00:00.000Z", nextClosure: "2026-11-26",
      nextEarlyCloseAt: "2026-11-27T18:00:00.000Z", nextEarlyCloseLocal: "13:00 ET" });
    const exceptions = nextVenueExceptions("XNYS", "America/New_York", now);
    expect(nextVenueExceptions("XNYS", "America/New_York", now + 1_000)).toBe(exceptions);
    expect(nextVenueExceptions("XNYS", "America/New_York", Date.parse("2026-11-26T05:00:00Z"))).not.toBe(exceptions);
    expect(venueExceptionLines(exceptions, 24)).toEqual([
      "Nov 26 closed", "Nov 27 early close", "13:00 ET / 18:00 UTC",
    ]);
    const beforeClose = nextVenueExceptions("XNYS", "America/New_York", Date.parse("2026-11-27T17:59:00Z"));
    expect(beforeClose.earlyClose?.date).toBe("2026-11-27");
    expect(nextVenueExceptions("XNYS", "America/New_York", Date.parse("2026-11-27T18:00:00Z")).earlyClose?.date).toBe("2026-12-24");
  } finally {
    setSystemTime();
  }
});

test("Singapore and Sydney publish the early-close date without treating freshness cutoffs as exact times", async () => {
  const now = Date.parse("2026-12-23T00:00:00Z");
  setSystemTime(now);
  try {
    const venues = [{ mic: "XSES", timezone: "Asia/Singapore", latitude: 1.28, longitude: 103.85 },
      { mic: "XASX", timezone: "Australia/Sydney", latitude: -33.86, longitude: 151.21 }].map((venue) => ({
      ...venue, name: venue.mic, title: venue.mic, city: "", country: "", countryCode: "", isOpen: false, session: "closed" as const,
    }));
    const client = { ...apiClient, getCloudWorldVenues: async () => ({ data: { checkedAt: now, venues } }) } as unknown as HeadlessPaneContext["apiClient"];
    const args = createTestHeadlessArgs({ argument: "venues" });
    const report = await mapHeadless.load(args, createTestHeadlessContext({ apiClient: client }));
    expect(report.rows).toHaveLength(2);
    for (const row of report.rows) expect(row).toMatchObject({ nextEarlyClose: "2026-12-24", nextEarlyCloseDate: "2026-12-24",
      nextEarlyCloseAt: null, nextEarlyCloseLocal: null });
    for (const { mic, timezone } of venues) {
      expect(venueExceptionLines(nextVenueExceptions(mic, timezone, now), 24)).toEqual(["Dec 25 closed", "Dec 24 early close"]);
    }
    const text = renderHeadlessPaneText(mapHeadless, report, args, "MAP");
    expect(text).toMatch(/^XASX .*2026-12-24$/m);
    expect(text).toMatch(/^XSES .*2026-12-24$/m);
  } finally {
    setSystemTime();
  }
});

test.each([
  ["XSES", "Asia/Singapore", "2026-12-24T04:20:00Z"],
  ["XASX", "Australia/Sydney", "2026-12-24T03:15:00Z"],
])("%s advances the early-close date at its cutoff without showing the time", (mic, timezone, cutoff) => {
  const boundary = Date.parse(cutoff);
  const before = nextVenueExceptions(mic, timezone, boundary - 60_000);
  expect(before.earlyClose).toEqual({ date: "2026-12-24", at: null, local: null });
  expect(nextVenueExceptions(mic, timezone, boundary - 1)).toBe(before);
  const after = nextVenueExceptions(mic, timezone, boundary);
  expect(after.earlyClose).toEqual({ date: "2026-12-31", at: null, local: null });
  expect(nextVenueExceptions(mic, timezone, boundary + 60_000)).toBe(after);
});
