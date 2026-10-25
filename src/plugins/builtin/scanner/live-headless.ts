import type { LiveScanPayload, LiveScanWireDefinition } from "../../../api-client/live-scan";
import type {
  HeadlessPaneDefinition,
  HeadlessPaneFreshness,
  HeadlessSnapshotResult,
} from "../../../types/plugin";
import { conditionColumnLabel, conditionText, DEFAULT_LIVE_SCAN, LIVE_SCAN_SECTORS, parseUniverseValue, readLiveScan, type LiveScan } from "./live-model";
import { LIVE_SCAN_INDEXES } from "../../../api-client/live-scan";

/** `all`, an index (`sp500`) or a sector (`Energy`), as `--universe` takes it. */
function parseHeadlessUniverse(value: string): LiveScan["universe"] {
  const text = value.trim();
  if (!text || text.toLowerCase() === "all") return { kind: "all" };
  const index = LIVE_SCAN_INDEXES.find((candidate) => candidate === text.toLowerCase());
  if (index) return parseUniverseValue(`index:${index}`);
  const sector = LIVE_SCAN_SECTORS.find((candidate) => candidate.toLowerCase() === text.toLowerCase());
  if (sector) return { kind: "sector", sector };
  throw new Error(`Universe must be all, ${LIVE_SCAN_INDEXES.join(", ")} or a sector: ${LIVE_SCAN_SECTORS.join(", ")}.`);
}

/** `--scan` is the conditions and floors as SCAN keeps them, in JSON; the default scan without it. */
function headlessScan(universe: string, json: string): LiveScan {
  let scan = DEFAULT_LIVE_SCAN;
  if (json.trim()) {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      throw new Error("--scan must be JSON, such as {\"conditions\":[{\"kind\":\"new_high\",\"within\":5}],\"minPrice\":5}.");
    }
    scan = readLiveScan(raw);
  }
  return { ...scan, universe: parseHeadlessUniverse(universe) };
}

function freshness(payload: LiveScanPayload): HeadlessPaneFreshness {
  if (payload.status === "closed") return { status: "not-a-feed", basis: "closed session" };
  if (payload.status === "degraded" || payload.status === "starting") return { status: "stale" };
  return payload.access === "realtime" ? { status: "live" } : { status: "delayed", delayMinutes: payload.delayMinutes };
}

function projectLiveScan(payload: LiveScanPayload, scan: LiveScan): HeadlessSnapshotResult {
  return {
    asOf: new Date(payload.asOf ?? payload.takenAt ?? Date.now()).toISOString(),
    items: payload.matches.map((match) => ({
      symbol: match.symbol,
      exchange: match.exchange ?? null,
      name: match.name,
      price: match.price,
      changePercent: match.changePercent,
      ...Object.fromEntries(scan.conditions.map((condition, index) => [conditionColumnLabel(condition), match.values[index] ?? null])),
      relativeVolume: match.relativeVolume,
      volume: match.volume,
      vwapPercent: match.vwapPercent,
      gapPercent: match.gapPercent,
    })),
    ...(payload.status === "degraded" ? { errors: ["Live scanner degraded"] } : {}),
    freshness: freshness(payload),
    metadata: {
      ...(payload.access === "delayed" ? { notices: [`Delayed ${payload.delayMinutes} minutes`] } : {}),
      ...(payload.warnings.length ? { warnings: payload.warnings } : {}),
      status: payload.status,
      access: payload.access,
      scanned: payload.scanned,
      matched: payload.matched,
      conditions: scan.conditions.map(conditionText),
    },
  };
}

export const liveScanHeadless: HeadlessPaneDefinition<"snapshot"> = {
  shape: "snapshot",
  description: "US stocks matching intraday conditions now: moves over the last minutes, volume spikes, new highs and lows, VWAP crosses and gaps.",
  argument: { kind: "none" },
  options: [
    {
      key: "universe",
      description: "all, an index (sp500, sp400, sp600, russell1000, russell2000) or a sector.",
      type: "string",
      defaultValue: "all",
      example: "--universe sp500",
      shot: { reportOnly: "picks the universe the report scans" },
    },
    {
      key: "scan",
      description: "Conditions and floors as JSON; the pane's default scan without it.",
      type: "string",
      defaultValue: "",
      placeholder: "json",
      shot: { reportOnly: "sets the conditions the report scans for" },
    },
  ],
  columns: [
    { key: "symbol", header: "Symbol" },
    { key: "name", header: "Name" },
    { key: "price", header: "Price", align: "right" },
    { key: "changePercent", header: "Chg %", align: "right" },
    { key: "relativeVolume", header: "RVol", align: "right" },
    { key: "volume", header: "Volume", align: "right" },
  ],
  describe: "Live Scanner",
  async load(args, ctx) {
    const scan = headlessScan(String(args.options.universe ?? "all"), String(args.options.scan ?? ""));
    const definition: LiveScanWireDefinition = {
      version: 1,
      universe: scan.universe.kind === "watchlist" ? { kind: "all" } : scan.universe,
      conditions: scan.conditions,
      ...(scan.minPrice != null ? { minPrice: scan.minPrice } : {}),
      ...(scan.minMarketCap != null ? { minMarketCap: scan.minMarketCap } : {}),
      ...(scan.minVolume != null ? { minVolume: scan.minVolume } : {}),
    };
    return projectLiveScan(await ctx.apiClient.getLiveScan(definition, ctx.signal), scan);
  },
};
