import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import { decodeHtmlEntities } from "../../../utils/html-entities";
import { httpFetch } from "../../../utils/http-transport";
import { describeHaltReason, parseEtDateTime, type HaltRecord } from "./model";

export const NASDAQ_HALTS_CONNECTION_ID = "nasdaq-trade-halts";

const HALTS_FEED_URL = "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts";
const FETCH_TIMEOUT_MS = 15_000;

const healthRegistrations = new WeakMap<
  ConnectionHealthRegistry,
  { references: number; dispose: () => void }
>();

export function acquireMarketHaltsHealth(health: ConnectionHealthRegistry): () => void {
  const current = healthRegistrations.get(health);
  if (current) {
    current.references += 1;
  } else {
    healthRegistrations.set(health, {
      references: 1,
      dispose: health.registerSource({
        id: NASDAQ_HALTS_CONNECTION_ID,
        name: "Nasdaq Trader",
        kind: "api",
        ownerId: "market-overview",
        detail: "nasdaqtrader.com",
        priority: 300,
      }),
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const registration = healthRegistrations.get(health);
    if (!registration) return;
    registration.references -= 1;
    if (registration.references > 0) return;
    registration.dispose();
    healthRegistrations.delete(health);
  };
}

function fieldValue(item: string, tag: string): string {
  const match = item.match(new RegExp(`<ndaq:${tag}[^>]*>([\\s\\S]*?)</ndaq:${tag}>`, "i"));
  return match ? decodeHtmlEntities(match[1]!).trim() : "";
}

export interface HaltFeedParseResult {
  records: HaltRecord[];
  /** `<item>` blocks seen, so an unparseable feed is not mistaken for a quiet day. */
  itemCount: number;
}

export function parseHaltFeed(xml: string): HaltFeedParseResult {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  const records: HaltRecord[] = [];

  for (const item of items) {
    const symbol = fieldValue(item, "IssueSymbol").toUpperCase();
    const haltDate = fieldValue(item, "HaltDate");
    const haltTime = fieldValue(item, "HaltTime");
    const haltedAt = parseEtDateTime(haltDate, haltTime);
    if (!symbol || haltedAt == null) continue;

    const resumptionDate = fieldValue(item, "ResumptionDate");
    const reasonCode = fieldValue(item, "ReasonCode").toUpperCase();
    records.push({
      id: `${symbol}|${haltDate}|${haltTime}|${reasonCode}`,
      symbol,
      company: fieldValue(item, "IssueName"),
      market: fieldValue(item, "Market"),
      reasonCode,
      reason: describeHaltReason(reasonCode),
      haltedAt,
      quoteResumeAt: parseEtDateTime(resumptionDate, fieldValue(item, "ResumptionQuoteTime")),
      tradeResumeAt: parseEtDateTime(resumptionDate, fieldValue(item, "ResumptionTradeTime")),
    });
  }

  return { records, itemCount: items.length };
}

async function loadHaltFeed(): Promise<HaltRecord[]> {
  const response = await httpFetch(HALTS_FEED_URL, {
    headers: { Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Nasdaq halt feed request failed (${response.status})`);
  }

  const xml = await response.text();
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml) || !/xmlns:ndaq=/i.test(xml)) {
    throw new Error("Nasdaq halt feed response was not RSS");
  }

  const { records, itemCount } = parseHaltFeed(xml);
  // Nasdaq publishes an empty channel on quiet days; items we cannot read mean
  // the format moved, which must not render as "no halts today".
  if (records.length === 0 && itemCount > 0) {
    throw new Error("Nasdaq halt feed format was not recognized");
  }
  return records;
}

export async function fetchMarketHalts(health?: ConnectionHealthRegistry): Promise<HaltRecord[]> {
  return health?.hasSource(NASDAQ_HALTS_CONNECTION_ID)
    ? health.track(NASDAQ_HALTS_CONNECTION_ID, "fetchTradeHalts", loadHaltFeed)
    : loadHaltFeed();
}
