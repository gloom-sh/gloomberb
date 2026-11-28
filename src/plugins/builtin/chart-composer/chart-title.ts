import { canonicalTickerKey, publicTickerKey } from "../../../utils/exchanges";
import { tickerInstrumentLabel } from "../../../tickers/instrument-label";
import { paneTitleMnemonic } from "../../../layout/pane-follow";
import type { ChartSpec } from "../../../time-series/types";
import { registeredSeriesName } from "./series-expression";

/** The commands that open a chart, each titling it with its series after it (`CMP SMH · QQQ`). */
const CHART_TITLE_PREFIXES = new Set(["G", "GP", "GIP", "CMP", "GF", "GE"]);

/** How many series a title names before it counts the rest (`+2`). */
const TITLE_SERIES_SHOWN = 3;

/**
 * What a registered series reads as in a chart's title: without its ticker
 * when the chart shows that ticker's price, and once for all of its lines
 * (`Z-score`, not `AAPL · Z-score · Z · AAPL · Z-score · Upper`).
 */
function capabilityTitlePart(
  source: { capabilityId: string; seriesId: string },
  label: string,
  pricedTickers: ReadonlySet<string>,
): { text: string; group: string | null } {
  const slash = source.seriesId.indexOf("/");
  const named = slash < 0 ? source.seriesId : source.seriesId.slice(0, slash);
  let ticker: string | null = null;
  if (slash >= 0) {
    try {
      ticker = decodeURIComponent(source.seriesId.slice(slash + 1));
    } catch {
      ticker = source.seriesId.slice(slash + 1);
    }
  }
  let text = label;
  if (ticker && pricedTickers.has(ticker.toUpperCase())) {
    for (const lead of [`${ticker} · `, `${ticker} `]) {
      if (text.startsWith(lead) && text.length > lead.length) {
        text = text.slice(lead.length);
        break;
      }
    }
  }
  const tilde = named.indexOf("~");
  if (tilde < 0) return { text, group: null };
  const lineAt = text.lastIndexOf(" · ");
  return {
    text: lineAt > 0 ? text.slice(0, lineAt) : text,
    group: `${source.capabilityId}:${named.slice(0, tilde)}/${ticker ?? ""}`,
  };
}

/** What a chart's title names of each of its series, in order: a ticker, a FRED series, a registered series once. */
function chartTitleParts(spec: ChartSpec): string[] {
  const pricedTickers = new Set(spec.series.flatMap((series) => series.source.kind === "security"
    ? [publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange).toUpperCase(),
      canonicalTickerKey(series.source.instrument.symbol, series.source.instrument.exchange).toUpperCase(),
      series.source.instrument.symbol.toUpperCase()]
    : []));
  const groups = new Set<string>();
  return spec.series.flatMap((series) => {
    if (series.source.kind === "security") {
      // The venue's own code (9992:HKEX), as the series' legend names it, never the saved key (9992:XHKG).
      return [tickerInstrumentLabel(canonicalTickerKey(series.source.instrument.symbol, series.source.instrument.exchange), series.source.instrument.instrument)];
    }
    if (series.source.kind === "economic") return [`FRED:${series.source.seriesId}`];
    const label = series.label?.trim() || registeredSeriesName(series.source) || series.source.seriesId;
    const { text, group } = capabilityTitlePart(series.source, label, pricedTickers);
    if (group) {
      if (groups.has(group)) return [];
      groups.add(group);
    }
    return [text];
  });
}

export function chartTitle(spec: ChartSpec, prefix = "G"): string {
  const parts = chartTitleParts(spec);
  const labels = parts.slice(0, TITLE_SERIES_SHOWN);
  if (labels.length === 0) return "Custom Chart";
  const remaining = parts.length - labels.length;
  return `${prefix} ${labels.join(" · ")}${remaining > 0 ? ` +${remaining}` : ""}`;
}

/**
 * Whether `title` is one a chart's series gave it: its command, then series
 * the chart draws (`CMP SMH · QQQ · RSP`, `+1` after them for more), or the
 * title of a chart with none. One the user gave the pane, or a command's own
 * (`G Chokepoint transits`), is not.
 */
function isSeriesTitle(title: string, spec: ChartSpec): boolean {
  if (title === chartTitle(spec)) return true;
  const prefix = paneTitleMnemonic(title);
  if (!prefix || !CHART_TITLE_PREFIXES.has(prefix)) return false;
  // A registered series' name can hold the separator itself (`MSFT · Bands`).
  if (title === chartTitle(spec, prefix)) return true;
  const named = title.slice(prefix.length).trim().replace(/ \+\d+$/, "");
  const parts = new Set(chartTitleParts(spec));
  return named.length > 0 && named.split(" · ").every((part) => parts.has(part));
}

/**
 * The title a chart pane takes when its series change from `previous` to
 * `next`, while its title is still the one its series gave it: SPY added to
 * `CMP SMH · QQQ · RSP` is counted (`CMP SMH · QQQ · RSP +1`), as `CMP SMH,
 * QQQ, RSP, SPY` titles it. Null when the series it names stay the same or
 * the user titled the pane.
 */
export function retitledChart(title: string | undefined, previous: ChartSpec, next: ChartSpec): string | null {
  const current = title?.trim();
  if (!current || !isSeriesTitle(current, previous)) return null;
  const prefix = paneTitleMnemonic(current);
  const command = prefix && CHART_TITLE_PREFIXES.has(prefix) ? prefix : "G";
  const retitled = chartTitle(next, command);
  return retitled === chartTitle(previous, command) || retitled === current ? null : retitled;
}
