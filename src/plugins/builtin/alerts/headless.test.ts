import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { capabilityPluginState, getPaneFunctionCapability, normalizeCapabilityOptions } from "../../../cli/pane-functions/capabilities";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneApiClient } from "../../../types/headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { createAlert } from "./alert-engine";
import { ALERTS_KEY, ALERTS_PLUGIN_ID } from "./constants";
import { EVENT_ALERTS_KEY, IV_LEVEL_ALERTS_KEY } from "./events";
import { appendFiredAlert, FIRED_LOG_KEY } from "./fired-log";
import { alertsHeadless } from "./headless";
import { IV_LEVEL_CHECKS_KEY } from "./iv-level";
import { createResearchAlert } from "./research-builder";
import { createScheduledAlert } from "./scheduled";

const pane = { id: "alerts", name: "Alerts", component: () => null, defaultPosition: "right" as const };
const capability = getPaneFunctionCapability({ id: "alerts-pane", paneId: "alerts", label: "Alerts", description: "Alerts", headless: alertsHeadless }, pane);

function contextWith(alerts: unknown[], events: unknown[]) {
  const config = createDefaultConfig("/tmp/gloomberb-alerts-headless-test");
  config.pluginConfig[ALERTS_PLUGIN_ID] = { [ALERTS_KEY]: JSON.stringify(alerts), [EVENT_ALERTS_KEY]: JSON.stringify(events) };
  return createTestHeadlessContext({ config });
}

test("ALRT takes --tab as the pane's own tab and refuses an unknown tab or option", () => {
  const strict = { strict: true, code: "ALRT" };
  expect(normalizeCapabilityOptions(capability, {}, strict)).toEqual({ tab: "prices" });
  const events = normalizeCapabilityOptions(capability, { tab: "events" }, strict);
  // The pane reads its tab from the pane state `tab` of the alerts plugin, which `shot` seeds from this.
  expect(capabilityPluginState(capability, events)).toEqual({ alerts: { tab: "events" } });
  expect(() => normalizeCapabilityOptions(capability, { tab: "bogus" }, strict)).toThrow('Invalid --tab value "bogus". Use one of: prices, events, history.');
  expect(() => normalizeCapabilityOptions(capability, { foo: "1" }, strict)).toThrow("ALRT does not support --foo. Supported options: --tab.");
});

test("--tab events lists the event alerts the Events tab shows, with their dates and lead time, and Prices points at them", async () => {
  const cpi = createScheduledAlert({ kind: "macro", event: "cpi" }, 1, "2026-11-10", Date.UTC(2026, 9, 17));
  const earnings = createScheduledAlert({ kind: "earnings", symbol: "CRWV", exchange: "" }, 3, "2026-11-09", Date.UTC(2026, 9, 18));
  const checked = { ...createAlert("CRWV", "above", 100), lastCheckedPrice: 90, lastQuoteProviderId: "internal" };
  const ctx = contextWith([checked], [cpi, earnings]);

  const events = await alertsHeadless.load(createTestHeadlessArgs({ options: { tab: "events" } }), ctx);
  // Newest first, as the tab sorts them.
  expect(events.rows.map((row) => [row.following, row.eventDate, row.leadDays, row.state])).toEqual([
    ["CRWV earnings", "2026-11-09", 3, "Active"],
    ["CPI release", "2026-11-10", 1, "Active"],
  ]);
  const text = renderHeadlessPaneText(alertsHeadless, events, createTestHeadlessArgs({ options: { tab: "events" } }), "ALRT");
  expect(text).toMatch(/CPI release\s+2026-11-10\s+1\s+Active/);

  const prices = await alertsHeadless.load(createTestHeadlessArgs({ options: { tab: "prices" } }), ctx);
  expect(prices.rows.map((row) => row.symbol)).toEqual(["CRWV"]);
  // The distance to target reads from the stored last price, and the quote's provider id stays out of the report.
  expect(prices.rows[0]).toMatchObject({ lastCheckedPrice: 90, awayPercent: expect.closeTo(11.11, 1) });
  expect(prices.rows[0]).not.toHaveProperty("lastQuoteProviderId");
  expect(renderHeadlessPaneText(alertsHeadless, prices, createTestHeadlessArgs(), "ALRT")).toMatch(/Active\s+CRWV\s+Price\s+90\.00\s+100\.00\s+\+11\.1%\s+Above/);
  expect(prices.notes).toEqual(["2 event alerts not listed here: gloom fn ALRT --tab events"]);
  expect((await alertsHeadless.load(createTestHeadlessArgs({ options: { tab: "prices" } }), contextWith([], []))).notes).toBeUndefined();
});

test("signed out, an event alert only a signed-in account gets checked reads Needs sign-in, with one line on signing in", async () => {
  const filing = createResearchAlert("filing_type", { "filing_type:symbol": "WHR", "filing_type:exchange": "US", "filing_type:form": "8-K" });
  const cpi = createScheduledAlert({ kind: "macro", event: "cpi" }, 1, "2026-11-10", Date.UTC(2026, 9, 17));
  const ctx = contextWith([], [filing, cpi]);
  const signedOut = await alertsHeadless.load(createTestHeadlessArgs({ options: { tab: "events" } }), ctx);
  // The app reads a CPI date itself, signed in or not.
  expect(signedOut.rows.map((row) => [row.following, row.state])).toEqual([["WHR · 8-K", "Needs sign-in"], ["CPI release", "Active"]]);
  expect(signedOut.notes).toEqual([expect.stringMatching(/^1 event alert needs sign-in: .*Log In or Sign Up\)\.$/)]);

  const signedIn = await alertsHeadless.load(createTestHeadlessArgs({ options: { tab: "events" } }), {
    ...ctx, apiClient: { getSessionToken: () => "session-token" } as unknown as HeadlessPaneApiClient,
  });
  expect(signedIn.rows.map((row) => row.state)).toEqual(["Active", "Active"]);
  expect(signedIn.notes).toBeUndefined();
});

test("a saved event list that does not read is reported, not shown as no alerts", async () => {
  const ctx = contextWith([], []);
  ctx.config.pluginConfig[ALERTS_PLUGIN_ID]![EVENT_ALERTS_KEY] = "{";
  const result = await alertsHeadless.load(createTestHeadlessArgs({ options: { tab: "events" } }), ctx);
  expect(result.rows).toEqual([]);
  expect(result.errors).toEqual(["Saved event alerts could not be read."]);
  expect(result.complete).toBe(false);
});

test("Prices exports the quote's own time and feed apart from the check time, and Away in percent; the text table is the pane's", async () => {
  const quotedAt = Date.UTC(2026, 9, 22, 20, 14);
  const checkedAt = Date.UTC(2026, 9, 22, 20, 31);
  const alert = { ...createAlert("IBIT", "above", 50), createdAt: Date.UTC(2026, 9, 20, 9, 30, 5, 678), lastCheckedPrice: 46.06, lastCheckedAt: checkedAt, lastQuoteUpdatedAt: quotedAt, lastQuoteSource: "delayed" };
  const args = createTestHeadlessArgs({ options: { tab: "prices" } });
  const result = await alertsHeadless.load(args, contextWith([alert], []));
  const table = headlessReportTables(alertsHeadless, result, args, "ALRT", deriveHeadlessFreshness(alertsHeadless, result), { complete: true, unavailableSymbols: [] }).tables[0]!;
  const cell = (header: string) => table.rows[0]![table.columns.indexOf(header)];
  expect(Date.parse(String(cell("Quote")))).toBe(quotedAt);
  expect(cell("Quote source")).toBe("delayed");
  expect(Date.parse(String(cell("Checked")))).toBe(checkedAt);
  // When it was made reads to the second, as alerts list and the pane's detail write it, not to the stored millisecond.
  expect(cell("Created")).toBe("2026-10-20T09:30:05Z");
  expect(table.columns.find((column) => column.startsWith("Away"))).toMatch(/%/);
  expect(Number(cell(table.columns.find((column) => column.startsWith("Away"))!))).toBeCloseTo(8.55, 1);
  // The terminal keeps the pane's columns: no source or check-time column of its own.
  const text = renderHeadlessPaneText(alertsHeadless, result, args, "ALRT");
  expect(text).toMatch(/State\s+Symbol\s+Measure\s+Current\s+Target\s+Away\s+Trigger\s+Quote\s+Alerted/);
  expect(text).not.toContain("Quote source");
});

test("History lists this app's fired alerts with no sign-in, and merges Gloom Cloud's deliveries in, newest first", async () => {
  const log = appendFiredAlert([], {
    kind: "price", ruleId: "alert-1", rule: "IBIT above 50", firedAt: Date.UTC(2026, 9, 16, 14, 0),
    value: 50.12, unit: "USD", quoteAt: "2026-10-16T13:59:00.000Z", source: "delayed", symbol: "IBIT",
  }, "fired-1");
  const context = (apiClient: unknown) => {
    const ctx = createTestHeadlessContext({ apiClient: apiClient as HeadlessPaneApiClient });
    ctx.readDeviceState = <T,>(pluginId: string, key: string) => (pluginId === ALERTS_PLUGIN_ID && key === FIRED_LOG_KEY ? log as T : null);
    return ctx;
  };
  const args = createTestHeadlessArgs({ options: { tab: "history" } });

  const signedOut = await alertsHeadless.load(args, context({ getMobileAlertHistory: async () => { throw new ApiRequestError("Sign in required", 401); } }));
  expect(signedOut.rows).toEqual([expect.objectContaining({ via: "This app", alert: "IBIT above 50", value: 50.12, unit: "USD", quoteAt: "2026-10-16T13:59:00.000Z", quoteSource: "delayed" })]);
  expect(signedOut.errors).toBeUndefined();
  expect(signedOut.notes?.[0]).toContain("Only the alerts this app fired are listed");

  const offsets: number[] = [];
  // Gloom Cloud also delivered the price alert the app fired, three minutes later.
  const delivered = { id: "p1", kind: "price", title: "IBIT 50.12", body: "Above your 50 alert", deliveredAt: "2026-10-16T14:03:00Z",
    data: { kind: "price", symbol: "IBIT", alertId: "alert-1" } };
  const page = (offset: number) => ({
    status: "ready", warning: null, asOf: "2026-10-17T12:00:00Z", states: [], deviceEnabled: true, syncAsOf: null,
    items: [{ id: `a${offset}`, kind: "earnings", title: `CRWV ${offset}`, body: "Reports soon", deliveredAt: `2026-10-1${offset + 5}T09:30:00Z` },
      ...offset === 1 ? [delivered] : []],
    hasMore: true, nextOffset: offset + 1,
  });
  const signedIn = await alertsHeadless.load(args, context({ getMobileAlertHistory: async (offset: number) => { offsets.push(offset); return page(offset); } }));
  // Five pages at most, the rest left to the pane's scrolling.
  expect(offsets).toEqual([0, 1, 2, 3, 4]);
  // The one alert both sent is one line, with the app's figure and quote and what the phone was told.
  expect(signedIn.rows.map((row) => [row.via, row.alert])).toEqual([
    ["Gloom Cloud", "CRWV 4"], ["Gloom Cloud", "CRWV 3"], ["Gloom Cloud", "CRWV 2"],
    ["This app and Gloom Cloud", "IBIT above 50"], ["Gloom Cloud", "CRWV 1"], ["Gloom Cloud", "CRWV 0"],
  ]);
  expect(signedIn.rows[3]).toMatchObject({ value: 50.12, quoteSource: "delayed", detail: "Above your 50 alert" });
  expect(signedIn.notes).toEqual(["Showing the latest 6 delivered alerts; the pane loads older ones as you scroll."]);
});

test("an IV level rule is listed from its own store, with this device's last reading", async () => {
  const level = createResearchAlert("iv_level", { "iv_level:symbol": "IBIT", "iv_level:exchange": "US", "iv_level:metric": "atm", "iv_level:direction": "above", "iv_level:threshold": "50" }, Date.UTC(2026, 9, 20));
  const ctx = contextWith([], []);
  ctx.config.pluginConfig[ALERTS_PLUGIN_ID]![IV_LEVEL_ALERTS_KEY] = JSON.stringify([level]);
  const check = { checkedAt: Date.UTC(2026, 9, 22, 20, 30), value: 37.46, quoteAt: "2026-10-22T20:14:59.999Z", source: "15 min delayed" };
  ctx.readDeviceState = <T,>(pluginId: string, key: string) => (pluginId === ALERTS_PLUGIN_ID && key === IV_LEVEL_CHECKS_KEY ? { [level.id]: check } as T : null);
  const result = await alertsHeadless.load(createTestHeadlessArgs({ options: { tab: "events" } }), ctx);
  expect(result.rows).toEqual([expect.objectContaining({ event: "IV level", following: "IBIT · 30d ATM IV above 50%", lastCheck: "37.46% · quotes 10-22 20:14 UTC, 15 min delayed", state: "Active" })]);
});
