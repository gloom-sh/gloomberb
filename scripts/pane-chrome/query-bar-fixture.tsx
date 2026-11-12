/** @jsxImportSource react */
/**
 * The `query-bar` scenario for the query bar checks (query-bar-checks.ts): one
 * query bar per row, each across the whole page, in the shapes the panes give
 * it: the price chart's ranges, extended hours and intervals (GP), a generic
 * future's roll and adjustment beside them, an option chain's expiry strip, a
 * statement with an as-of, a list with a search and filters, and a range
 * alone. The choices work, so a picture shows what a click leaves. Nothing is
 * fetched.
 */
import { useState } from "react";
import { QueryBar, type QueryBarFilter, type QueryBarView } from "../../src/components/ui/query-bar";
import { Box, Text } from "../../src/ui";

const noop = () => {};
const RANGES = ["1D", "1W", "1M", "3M", "6M", "1Y", "5Y", "ALL"].map((label, index) => ({ label, value: label, hint: String(index + 1) }));
const INTRADAY = ["Auto (1m)", "1m", "5m", "15m", "30m", "1h"].map((label) => ({ label, value: label }));
const LONG = ["Auto (W)", "D", "W", "M"].map((label) => ({ label, value: label }));
const EXPIRIES = Array.from({ length: 24 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 10, 20) + index * 7 * 86_400_000);
  const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return { label, value: String(index) };
});

interface QueryBarCase {
  name: string;
  filters?: QueryBarFilter[];
  view?: QueryBarView;
  meta?: string;
  asOf?: string;
  search?: boolean;
}

/** The bars, by the name the checks give them. */
export const QUERY_BAR_CASES: QueryBarCase[] = [
  {
    name: "price chart, intraday",
    filters: [
      { id: "range", label: "Range", inline: true, chartRange: true, value: "1D", options: RANGES, onChange: noop },
      { id: "extended-hours", kind: "toggle", label: "Extended hours", short: "Ext hours", value: false, onChange: noop },
    ],
    view: { value: "Auto (1m)", options: INTRADAY, onChange: noop },
  },
  {
    name: "price chart, five years",
    filters: [{ id: "range", label: "Range", inline: true, chartRange: true, value: "5Y", options: RANGES, onChange: noop }],
    view: { value: "Auto (W)", options: LONG, onChange: noop },
  },
  {
    name: "generic future, total return, a date window",
    filters: [
      { id: "range", label: "Range", inline: true, value: "", options: RANGES, onChange: noop },
      { id: "roll", label: "Roll", value: "volume", options: [{ value: "volume", label: "Volume" }, { value: "expiry", label: "Expiry" }], onChange: noop },
      { id: "adjust", label: "Adjust", value: "ratio", options: [{ value: "none", label: "None" }, { value: "ratio", label: "Ratio" }], onChange: noop },
      { id: "total-return", kind: "toggle", label: "Total return", short: "Total ret", value: true, onChange: noop },
    ],
    view: { value: "Auto (D)", options: ["Auto (D)", "D", "W", "M"].map((label) => ({ label, value: label })), onChange: noop },
    meta: "Jan 3, 2024 to Mar 1, 2025",
  },
  {
    name: "option chain",
    filters: [
      { id: "strikes", label: "Strikes", value: "10", defaultValue: "all", options: [{ value: "all", label: "All" }, { value: "10", label: "±10" }], onChange: noop },
      { id: "expiration", label: "Exp", inline: true, scrolls: true, value: "5", options: EXPIRIES, onChange: noop },
    ],
  },
  {
    name: "statement with an as-of",
    filters: [{
      id: "statement",
      label: "Statement",
      inline: true,
      value: "income",
      options: ["Income", "Cash Flow", "Balance Sheet", "Ratios"].map((label) => ({ value: label.toLowerCase(), label })),
      onChange: noop,
    }],
    view: { value: "annual", options: [{ value: "annual", label: "Annual" }, { value: "quarterly", label: "Quarterly" }], onChange: noop },
    asOf: "as of 2026-06-30",
    meta: "YoY",
  },
  {
    name: "list with a search",
    search: true,
    filters: [
      { id: "country", label: "Country", value: "all", options: [{ value: "all", label: "All countries" }, { value: "us", label: "United States" }], onChange: noop },
      { id: "sector", label: "Sector", value: "tech", defaultValue: "all", options: [{ value: "all", label: "All" }, { value: "tech", label: "Technology" }], onChange: noop },
      { id: "side", label: "Side", inline: true, value: "buy", options: [{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }], onChange: noop },
    ],
    view: { value: "1y", options: [{ value: "1m", label: "1M" }, { value: "1y", label: "1Y" }, { value: "5y", label: "5Y" }], onChange: noop },
  },
  {
    name: "a range alone",
    view: { value: "5Y", options: ["1M", "3M", "6M", "1Y", "2Y", "5Y", "10Y", "MAX"].map((label, index) => ({ label, value: label, hint: String(index + 1) })), onChange: noop },
  },
];

/** A case whose choices answer clicks, as the pane's do. */
function CaseBar({ bar }: { bar: QueryBarCase }) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [view, setView] = useState(bar.view?.value);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(false);
  const filters = bar.filters?.map((filter): QueryBarFilter => {
    if (filter.kind === "toggle") {
      return { ...filter, value: (values[filter.id] as boolean | undefined) ?? filter.value, onChange: (value) => setValues((all) => ({ ...all, [filter.id]: value })) };
    }
    if (filter.kind === "multi" || filter.kind === "text") return filter;
    return { ...filter, value: (values[filter.id] as string | undefined) ?? filter.value, onChange: (value: string) => setValues((all) => ({ ...all, [filter.id]: value })) };
  });
  return (
    <QueryBar
      width={160}
      search={bar.search ? { value: query, onChange: setQuery, placeholder: "company or ticker", focused: false, active, onActiveChange: setActive } : undefined}
      filters={filters}
      view={bar.view ? { ...bar.view, value: view, onChange: setView } : undefined}
      meta={bar.meta}
      asOf={bar.asOf}
    />
  );
}

export function QueryBarFixture() {
  return (
    <Box flexDirection="column" width="100%" height="100%">
      {QUERY_BAR_CASES.map((bar) => (
        <Box key={bar.name} data-query-bar-case={bar.name} flexDirection="column" width="100%" flexShrink={0}>
          <Box height={1} paddingX={1}><Text>{bar.name}</Text></Box>
          <CaseBar bar={bar} />
        </Box>
      ))}
    </Box>
  );
}
