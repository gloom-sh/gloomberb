import { useEffect, useMemo, useRef, useState } from "react";
import { ListingArgError, readBareListing, type ListingChoice } from "../../../cli/listing-arg";
import { shortCompanyName } from "../../../tickers/company-name";
import type { ListingDeps } from "../../../tickers/listing-venues";
import { hydrateChartSpecInstruments } from "../../../time-series/hooks";
import type { ChartSpec } from "../../../time-series/types";
import type { TickerRecord } from "../../../types/ticker";
import { useAppSelector } from "../../../state/app/context";
import { logFailure } from "../../../utils/log-failure";
import { useAssetData } from "../../runtime";
import { bareCatalogCandidate, registryCatalogLookups, withCatalogLabel } from "./catalog-series";

/** What one security series' listing came to. */
type SeriesListing =
  | { status: "pending" }
  /**
   * Its company, and for a bare symbol the listing `quote` reads it as: the symbol (NDX is read as the
   * index ^NDX) and the venue (NIM; empty when its own quote answered).
   */
  | { status: "read"; symbol: string; exchange: string; name: string | null; notATicker?: true }
  /** A bare code several companies list (BDI): `quote`'s question, and the listings it names. */
  | { status: "choose"; message: string; listings: string | null; choices: string | null };

interface SeriesListings {
  /** The spec to load: bare series on the venue they were read on; one still being read, or to choose, left out with what draws on it. */
  spec: ChartSpec;
  /** A bare series is still being read. */
  pending: boolean;
  /** "Choose an exchange for BDI.", one per code. */
  errors: string[];
  /** The listings each question names: "Listings: BDI:TSX Black Diamond Group, BDI:BSE B.D. Industries". */
  notices: string[];
  /** Under each question, the listings it asks between, short: "BDI:TSX Black Diamond Group · BDI:BSE B. D. Industries (Pune)". */
  choices: ReadonlyMap<string, string>;
  /** The company of each security series, by series id. */
  names: ReadonlyMap<string, string>;
}

/** The listings `quote` names under its question, on one line: the pane has no room for a list. */
function listingsLine(details: string | undefined): string | null {
  if (!details) return null;
  const [heading = "", ...lines] = details.split("\n");
  if (lines.length === 0) return details.trim() || null;
  return `${heading.replace(/:$/, "")}: ${lines.map((line) => line.trim()).filter(Boolean).join(", ")}`;
}

/** "BDI:TSX Black Diamond Group · BDI:NEO Black Diamond Group": the listings to choose from, on one short line. */
function choicesLine(choices: readonly ListingChoice[] | undefined): string | null {
  if (!choices?.length) return null;
  return choices.map(({ key, name }) => (name?.trim() ? `${key} ${shortCompanyName(name)}` : key)).join(" · ");
}

function targetKey(symbol: string, exchange: string): string {
  return `${symbol.trim().toUpperCase()}|${exchange.trim().toUpperCase()}`;
}

/**
 * Reads a chart's security series as `quote` and `fn G` read them
 * (`readBareListing`): a bare symbol saved nowhere goes to the listing its
 * own quote answers for, or to the first of its listings with a quote, and a
 * code several companies list (BDI is Black Diamond Group in Toronto and
 * B. D. Industries in Pune) is not charted from one of them but asks which,
 * with `quote`'s message. Each series names its company from that quote, or
 * from its own listing's quote when it names its venue. A bare symbol no
 * ticker answers to that the catalog names a series by (DFII10) is that
 * series, and a FRED series is labelled by the catalog's short name, as
 * `fn G` reads them (catalog-series).
 */
export function useSeriesListings(spec: ChartSpec): SeriesListings {
  const dataProvider = useAssetData();
  const tickers = useAppSelector((state) => state.tickers);
  const hydrated = useMemo(() => hydrateChartSpecInstruments(spec, tickers), [spec, tickers]);
  const tickersRef = useRef<ReadonlyMap<string, TickerRecord>>(tickers);
  tickersRef.current = tickers;
  const [read, setRead] = useState<ReadonlyMap<string, SeriesListing>>(() => new Map());
  // Each listing is read once while the pane is open; a read still out when it closes is dropped.
  const started = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; started.current.clear(); };
  }, []);

  const targets = useMemo(() => {
    const found = new Map<string, { symbol: string; exchange: string }>();
    for (const entry of hydrated.series) {
      // A broker's contract is read by the broker, as it was picked.
      if (entry.source.kind !== "security" || entry.source.instrument.instrument) continue;
      const { symbol, exchange = "" } = entry.source.instrument;
      found.set(targetKey(symbol, exchange), { symbol: symbol.trim().toUpperCase(), exchange: exchange.trim() });
    }
    return found;
  }, [hydrated]);

  useEffect(() => {
    if (!dataProvider) return;
    const deps: ListingDeps = {
      dataProvider,
      store: {
        loadTicker: async (symbol) => tickersRef.current.get(symbol.toUpperCase()) ?? null,
        loadAllTickers: async () => [...tickersRef.current.values()],
      },
    };
    const settle = (key: string, listing: SeriesListing) => {
      if (mounted.current) setRead((previous) => new Map(previous).set(key, listing));
    };
    for (const [key, { symbol, exchange }] of targets) {
      if (started.current.has(key)) continue;
      started.current.add(key);
      if (exchange) {
        // A named venue is charted as named; its quote names the company.
        void dataProvider.getQuote(symbol, exchange)
          .then((quote) => settle(key, { status: "read", symbol, exchange, name: quote?.name?.trim() || null }))
          .catch(() => settle(key, { status: "read", symbol, exchange, name: null }));
        continue;
      }
      settle(key, { status: "pending" });
      void readBareListing(symbol, deps, { command: "G", noun: "a quote", retry: null })
        // A symbol no listing carries is left to the chart's own request, which says so, unless the catalog names a series by it.
        .then((listing) => settle(key, listing && !("notATicker" in listing)
          ? { status: "read", symbol: listing.symbol, exchange: listing.exchange, name: listing.name }
          : { status: "read", symbol, exchange: "", name: null, ...listing ? { notATicker: true as const } : {} }))
        .catch((error: unknown) => {
          if (error instanceof ListingArgError) {
            settle(key, {
              status: "choose",
              message: error.message,
              listings: listingsLine(error.details),
              choices: choicesLine(error.choices),
            });
            return;
          }
          logFailure("chart-composer.series-listings", "Read a bare series listing failed")(error);
          // The chart's own request speaks for a symbol nothing better is known of.
          settle(key, { status: "read", symbol, exchange: "", name: null });
        });
    }
  }, [dataProvider, targets]);

  return useMemo(() => {
    const dropped = new Set<string>();
    const names = new Map<string, string>();
    const errors = new Set<string>();
    const notices = new Set<string>();
    const choices = new Map<string, string>();
    let pending = false;
    let changed = false;
    const catalog = registryCatalogLookups();
    const series = hydrated.series.flatMap((entry) => {
      // A FRED series reads by the catalog's short name however it was typed, as `fn G` labels it.
      if (entry.source.kind !== "security") {
        const labelled = withCatalogLabel(entry, catalog);
        if (labelled !== entry) changed = true;
        return [labelled];
      }
      if (entry.source.instrument.instrument) return [entry];
      const { symbol, exchange = "" } = entry.source.instrument;
      const listing = read.get(targetKey(symbol, exchange));
      if (!listing || listing.status === "pending") {
        if (exchange.trim()) return [entry];
        pending = true;
        dropped.add(entry.id);
        changed = true;
        return [];
      }
      if (listing.status === "choose") {
        errors.add(listing.message);
        if (listing.listings) notices.add(listing.listings);
        if (listing.choices) choices.set(listing.message, listing.choices);
        dropped.add(entry.id);
        changed = true;
        return [];
      }
      // A FRED id (DFII10) or a series alias (hashrate) no ticker answers to is that series, as `fn G` charts it.
      const named = listing.notATicker ? bareCatalogCandidate(entry, catalog) : null;
      if (named) {
        changed = true;
        return [named];
      }
      // A series labeled for what it is (FUT:CL is "WTI Crude Oil") names nothing more.
      if (listing.name && !entry.label?.trim()) names.set(entry.id, listing.name);
      if (exchange.trim() || !listing.exchange) return [entry];
      changed = true;
      // The listing read, symbol and venue both: NDX charts the Nasdaq-100 as ^NDX:NIM, not a line NDX:NIM no venue has.
      return [{ ...entry, source: { ...entry.source, instrument: { ...entry.source.instrument, symbol: listing.symbol, exchange: listing.exchange } } }];
    });
    // A study drawn on a series left out has nothing to draw yet.
    const studies = hydrated.studies.filter((study) => {
      if (!study.inputSeriesIds.some((id) => dropped.has(id))) return true;
      dropped.add(study.id);
      return false;
    });
    return {
      spec: changed ? { ...hydrated, series, studies } : hydrated,
      pending,
      errors: [...errors],
      notices: [...notices],
      choices,
      names,
    };
  }, [hydrated, read]);
}
