import { apiClient } from "../../../api-client";
import type { CatalystEvent } from "../../../api-client/catalysts";
import type { GloomPluginContext } from "../../../types/plugin";
import { publicTickerKey, parsePublicTickerKey } from "../../../utils/exchanges";
import { EVENT_ALERTS_KEY, readEventAlerts, type EventAlertRule } from "./events";

export const CATALYST_POLL_STATUS = "catalystPollStatus";
interface Cursor { since: string; cursor?: string; delivered: Record<string, string>; }
export function catalystMatches(rule: EventAlertRule, event: CatalystEvent, watched: ReadonlySet<string>): boolean {
  if (rule.kind !== "catalyst" || rule.status !== "active" || Date.parse(event.observedAt) < rule.createdAt) return false;
  const target = rule.value.toUpperCase();
  switch (rule.target) {
    case "ticker": return event.parties.some((party) => party.ticker && (parsePublicTickerKey(target).exchange ? publicTickerKey(party.ticker, party.exchange ?? undefined).toUpperCase() === publicTickerKey(target).toUpperCase() : party.ticker.toUpperCase() === target));
    case "watched": return event.parties.some((party) => party.ticker && watched.has(publicTickerKey(party.ticker, party.exchange ?? undefined).toUpperCase()));
    case "type": return event.type.toUpperCase() === target;
    case "agency": return event.agency.toUpperCase() === target;
    case "country": return (event.country ?? event.jurisdiction).toUpperCase() === target;
    default: return false;
  }
}
/** Catalyst delivery is local to the running app; cursor state never enters mobile delivery. */
export function startCatalystAlerts(ctx: GloomPluginContext): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  const currentRules = () => readEventAlerts(ctx.configState.get<string>(EVENT_ALERTS_KEY) ?? "[]").rules.filter((rule) => rule.kind === "catalyst" && rule.status === "active");
  const poll = async () => {
    if (stopped || !apiClient.isSignedIn()) return;
    const rules = currentRules();
    if (!rules.length) return;
    const user = apiClient.getCurrentUser();
    if (!user) return;
    const key = `catalysts:${user?.id ?? "session"}`;
    const since = new Date(Math.min(...rules.map((rule) => rule.createdAt))).toISOString();
    const saved = ctx.resume.getState<Cursor>(key);
    const state: Cursor = saved && saved.since <= since ? saved : { since, delivered: saved?.delivered ?? {} };
    const tickers = await ctx.tickerRepository.loadAllTickers();
    const watched = new Set(tickers.filter(({ metadata }) => metadata.watchlists.length || metadata.portfolios.length).map(({ metadata }) => publicTickerKey(metadata.ticker, metadata.exchange).toUpperCase()));
    controller = new AbortController();
    let catchingUp = false;
    for (let page = 0; page < 5 && !stopped; page++) {
      const feed = await apiClient.getCloudCatalystChanges({ since: state.since, cursor: state.cursor, limit: 200 }, controller.signal);
      if (stopped || apiClient.getCurrentUser()?.id !== user?.id) return;
      if (!Array.isArray(feed.events) || feed.events.some((event) => !/^\d+$/.test(event.revisionId))) throw new Error("Invalid catalyst alert feed.");
      if (feed.nextCursor && (!/^\d+$/.test(feed.nextCursor) || (state.cursor && BigInt(feed.nextCursor) < BigInt(state.cursor)))) throw new Error("Invalid catalyst alert cursor.");
      if (feed.hasMore && (!feed.nextCursor || feed.nextCursor === state.cursor)) throw new Error("Catalyst alert cursor did not advance.");
      catchingUp = feed.hasMore;
      for (const event of feed.events) {
        for (const rule of currentRules()) {
          const ruleKey = `${rule.id}:${rule.createdAt}`;
          if (state.delivered[ruleKey] && BigInt(state.delivered[ruleKey]!) >= BigInt(event.revisionId)) continue;
          if (!catalystMatches(rule, event, watched)) continue;
          ctx.notify({ body: `${event.title} · ${event.status}`, type: "info", desktop: "always", persistent: true,
            action: { label: "Open catalyst", onClick: () => ctx.createPaneFromTemplate("catalysts-pane", { values: { event: event.id }, symbol: (() => { const party = event.parties.find((party) => party.ticker); return party?.ticker ? publicTickerKey(party.ticker, party.exchange ?? undefined) : undefined; })() }) } });
          state.delivered[ruleKey] = event.revisionId;
        }
      }
      if (feed.nextCursor) state.cursor = feed.nextCursor;
      const activeKeys = new Set(currentRules().map((rule) => `${rule.id}:${rule.createdAt}`));
      state.delivered = Object.fromEntries(Object.entries(state.delivered).filter(([id]) => activeKeys.has(id)));
      ctx.resume.setState(key, state);
      if (!feed.hasMore) break;
    }
    await ctx.configState.set(CATALYST_POLL_STATUS, catchingUp ? "Catching up on catalyst changes" : `Catalysts checked ${new Date().toISOString().slice(11, 16)} UTC`);
  };
  const run = async () => {
    try { await poll(); }
    catch (error) {
      if (!stopped) {
        ctx.log.warn("Catalyst alerts unavailable", { error: String(error) });
        await ctx.configState.set(CATALYST_POLL_STATUS, error instanceof Error ? error.message : "Catalyst alerts unavailable");
      }
    } finally { if (!stopped) timer = setTimeout(() => void run(), 5 * 60_000); }
  };
  void run();
  return () => { stopped = true; controller?.abort(); if (timer) clearTimeout(timer); };
}
