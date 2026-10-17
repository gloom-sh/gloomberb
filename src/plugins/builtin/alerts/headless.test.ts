import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { capabilityPluginState, getPaneFunctionCapability, normalizeCapabilityOptions } from "../../../cli/pane-functions/capabilities";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneApiClient } from "../../../types/headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { createAlert } from "./alert-engine";
import { ALERTS_KEY, ALERTS_PLUGIN_ID } from "./constants";
import { EVENT_ALERTS_KEY } from "./events";
import { alertsHeadless } from "./headless";
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
  expect(renderHeadlessPaneText(alertsHeadless, prices, createTestHeadlessArgs(), "ALRT")).toMatch(/Active\s+CRWV\s+90\.00\s+100\.00\s+\+11\.1%\s+Above/);
  expect(prices.notes).toEqual(["2 event alerts not listed here: gloomberb fn ALRT --tab events"]);
  expect((await alertsHeadless.load(createTestHeadlessArgs({ options: { tab: "prices" } }), contextWith([], []))).notes).toBeUndefined();
});

test("a saved event list that does not read is reported, not shown as no alerts", async () => {
  const ctx = contextWith([], []);
  ctx.config.pluginConfig[ALERTS_PLUGIN_ID]![EVENT_ALERTS_KEY] = "{";
  const result = await alertsHeadless.load(createTestHeadlessArgs({ options: { tab: "events" } }), ctx);
  expect(result.rows).toEqual([]);
  expect(result.errors).toEqual(["Saved event alerts could not be read."]);
  expect(result.complete).toBe(false);
});

test("History reads the delivered alerts page by page up to a cap, and a signed-out read says what to do instead of failing bare", async () => {
  const offsets: number[] = [];
  const page = (offset: number) => ({
    status: "ready", warning: null, asOf: "2026-10-17T12:00:00Z", states: [], deviceEnabled: true, syncAsOf: null,
    items: [{ id: `a${offset}`, kind: "earnings", title: `CRWV ${offset}`, body: "Reports soon", deliveredAt: "2026-10-16T09:30:00Z" }],
    hasMore: true, nextOffset: offset + 1,
  });
  const args = createTestHeadlessArgs({ options: { tab: "history" } });
  const read = await alertsHeadless.load(args, createTestHeadlessContext({
    apiClient: { getMobileAlertHistory: async (offset: number) => { offsets.push(offset); return page(offset); } } as unknown as HeadlessPaneApiClient,
  }));
  expect(offsets).toEqual([0, 1, 2, 3, 4]);
  expect(read.rows).toHaveLength(5);
  expect(read.notes).toEqual(["Showing the latest 5 delivered alerts; the pane loads older ones as you scroll."]);

  const refused = alertsHeadless.load(args, createTestHeadlessContext({
    apiClient: { getMobileAlertHistory: async () => { throw new ApiRequestError("Sign in required", 401); } } as unknown as HeadlessPaneApiClient,
  }));
  await expect(refused).rejects.toThrow(/ALRT History needs a free Gloom sign-in/);
});
