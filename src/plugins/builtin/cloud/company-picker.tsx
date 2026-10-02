/**
 * "Which companies do you follow?", asked once of a brand-new account whose
 * lists are still the ones the app seeded. Alerts on the seeded tickers bring
 * about 3.5% of idle people back, against 8.8% for tickers they chose and
 * 13.5% for positions, and the Monday brief only covers chosen tickers. So
 * the picks go on the watchlist and the seeded names nobody picked come off:
 * the list becomes theirs, and the server can tell (fewer than 7 starters
 * left means the list was made by hand).
 *
 * The native onboarding already asks for a holding or a followed company, so
 * this is for everyone who signs up without it, which is most people: the web
 * terminal and sign-ups from gloom.sh. It uses the onboarding's card so the
 * two read as one product.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient, type AuthUser } from "../../../api-client";
import { useKeybindings } from "../../../app/keybindings";
import { resolveCompanyLogoSrc } from "../../../components/company-logo";
import {
  keyReachesPastOnboardingModal,
} from "../../../components/onboarding/onboarding-wizard";
import {
  OnboardingActions,
  OnboardingButton,
  OnboardingModal,
  OnboardingTitle,
} from "../../../components/onboarding/onboarding-frame";
import { Button } from "../../../components/ui/button";
import { TextField } from "../../../components/ui/fields";
import { ListView, type ListViewItem } from "../../../components/ui/list-view";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { useShortcut } from "../../../react/input";
import { useAppDispatch, useAppSelector, useAppStateRef } from "../../../state/app/context";
import { blendHex } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { getSearchResultSymbol } from "../../../tickers/search/result";
import { upsertTickerFromSearchResult } from "../../../tickers/search/upsert";
import type { InstrumentSearchResult } from "../../../types/instrument";
import type { TickerMetadata, TickerRecord } from "../../../types/ticker";
import { Box, ImageSurface, Text, TextAttributes, useUiCapabilities, type InputRenderable } from "../../../ui";
import { Icon } from "../../../components/ui/icon";
import { useToastHost } from "../../../ui/toast";
import { debugLog } from "../../../utils/debug-log";
import { isPlainKey } from "../../../utils/keyboard";
import type { PluginRegistry } from "../../registry";

const log = debugLog.createLogger("company-picker");

const MIN_COMPANY_PICKS = 2;
/** Only accounts this new are asked; nobody who has used Gloom for a while. */
const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;
/** The seeded lists hold 7 (web first run) or 12 (startup) starter tickers. */
const SEEDED_LIST_MIN_STARTERS = 7;
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_RESULTS = 6;
const GRID_COLUMNS = 4;

/**
 * Every ticker the app seeds: `DEFAULT_WATCHLIST_TICKERS` in
 * src/state/app/bootstrap.ts and `FIRST_RUN_WATCHLIST` in
 * src/components/onboarding/first-run-workspace.ts. A test keeps them equal.
 */
export const STARTER_SYMBOLS: ReadonlySet<string> = new Set([
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "TSLA", "META", "BRK.B", "JPM", "V", "BTC-USD", "ETH-USD", "SPY", "QQQ",
]);

type Suggestion = Pick<TickerMetadata, "ticker" | "name" | "exchange" | "assetCategory" | "currency">;

/** What people most often follow: big names first, then an index fund and bitcoin. */
const COMPANY_SUGGESTIONS: readonly Suggestion[] = [
  { ticker: "NVDA", name: "NVIDIA", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "AAPL", name: "Apple", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "MSFT", name: "Microsoft", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "TSLA", name: "Tesla", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "AMZN", name: "Amazon", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "META", name: "Meta", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "GOOGL", name: "Alphabet", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "AMD", name: "AMD", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "PLTR", name: "Palantir", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "AVGO", name: "Broadcom", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "NFLX", name: "Netflix", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "COIN", name: "Coinbase", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "JPM", name: "JPMorgan", exchange: "NYSE", assetCategory: "STK", currency: "USD" },
  { ticker: "BRK.B", name: "Berkshire", exchange: "NYSE", assetCategory: "STK", currency: "USD" },
  { ticker: "SPY", name: "S&P 500 ETF", exchange: "NYSEARCA", assetCategory: "ETF", currency: "USD" },
  { ticker: "BTC-USD", name: "Bitcoin", exchange: "CCC", assetCategory: "CRYPTO", currency: "USD" },
];

export interface CompanyPick {
  symbol: string;
  name: string;
  /** A suggestion's metadata, for a ticker the app does not have yet. */
  seed?: Suggestion;
  /** A search result, saved through the usual search upsert on confirm. */
  result?: InstrumentSearchResult;
}

/**
 * Whether this account still has only what the app seeded: nothing in a
 * portfolio (holding or followed) and a watchlist that is empty or the
 * untouched starter list.
 */
export function needsCompanyPicks(tickers: Iterable<TickerRecord>, watchlistId: string | undefined): boolean {
  let starters = 0;
  for (const ticker of tickers) {
    if (ticker.metadata.portfolios.length > 0 || ticker.metadata.positions.length > 0) return false;
    if (!watchlistId || !ticker.metadata.watchlists.includes(watchlistId)) continue;
    if (!STARTER_SYMBOLS.has(ticker.metadata.ticker)) return false;
    starters += 1;
  }
  return starters === 0 || starters >= SEEDED_LIST_MIN_STARTERS;
}

export function isNewAccount(user: Pick<AuthUser, "createdAt"> | null, now = Date.now()): boolean {
  const created = user?.createdAt ? Date.parse(user.createdAt) : Number.NaN;
  return Number.isFinite(created) && now - created >= 0 && now - created < NEW_ACCOUNT_MS;
}

export interface CompanyPickPlan {
  /** Picks the app has no ticker for yet, created on the watchlist. */
  create: TickerMetadata[];
  /** Existing tickers joining the watchlist, or seeded ones leaving it. */
  update: TickerRecord[];
}

/** The writes that make the watchlist the picks, minus seeded names nobody picked. */
export function planCompanyPicks(
  tickers: ReadonlyMap<string, TickerRecord>,
  watchlistId: string,
  picks: readonly CompanyPick[],
): CompanyPickPlan {
  const picked = new Set(picks.map((pick) => pick.symbol));
  const create: TickerMetadata[] = [];
  for (const pick of picks) {
    if (tickers.has(pick.symbol)) continue;
    const seed = pick.seed;
    create.push({
      ticker: pick.symbol,
      name: seed?.name ?? pick.name,
      exchange: seed?.exchange ?? "",
      currency: seed?.currency ?? "USD",
      ...(seed?.assetCategory ? { assetCategory: seed.assetCategory } : {}),
      portfolios: [],
      watchlists: [watchlistId],
      positions: [],
      custom: {},
      tags: [],
    });
  }
  const update: TickerRecord[] = [];
  for (const ticker of tickers.values()) {
    const symbol = ticker.metadata.ticker;
    const listed = ticker.metadata.watchlists.includes(watchlistId);
    if (picked.has(symbol) && !listed) {
      update.push({ ...ticker, metadata: { ...ticker.metadata, watchlists: [...ticker.metadata.watchlists, watchlistId] } });
    } else if (!picked.has(symbol) && listed && STARTER_SYMBOLS.has(symbol)) {
      update.push({ ...ticker, metadata: { ...ticker.metadata, watchlists: ticker.metadata.watchlists.filter((id) => id !== watchlistId) } });
    }
  }
  return { create, update };
}

/** Stocks, funds and coins; options, futures and the like are not something you "follow" here. */
function isFollowableResult(result: InstrumentSearchResult) {
  return !/option|future|warrant|index/i.test(result.type);
}

type SearchCompanies = (query: string) => Promise<InstrumentSearchResult[]>;

function selectionHint(picks: readonly CompanyPick[]) {
  if (picks.length === 0) return tf("Pick at least {count} to continue.", { count: MIN_COMPANY_PICKS });
  const names = picks.map((pick) => pick.symbol).join(", ");
  const remaining = MIN_COMPANY_PICKS - picks.length;
  return remaining > 0 ? tf("{names}. {count} more to go.", { names, count: remaining }) : names;
}

/** Logo tile for the desktop card; the first letter stands in until it loads. */
function LogoTile({ symbol, assetCategory, size }: { symbol: string; assetCategory?: string; size: number }) {
  const colors = useThemeColors();
  const src = resolveCompanyLogoSrc({ symbol, assetCategory });
  const tile = {
    width: size,
    height: size,
    borderRadius: 7,
    flexShrink: 0,
    overflow: "hidden",
    backgroundColor: blendHex(colors.panel, colors.textBright, 0.06),
  } as const;
  const letter = (
    <Text fg={colors.textMuted} attributes={TextAttributes.BOLD} style={{ fontSize: Math.round(size * 0.45) }}>
      {symbol.charAt(0)}
    </Text>
  );
  if (!src) {
    return <Box alignItems="center" justifyContent="center" style={tile}>{letter}</Box>;
  }
  return (
    <ImageSurface src={src} alt={symbol} objectFit="contain" alignItems="center" justifyContent="center" style={tile}>
      {letter}
    </ImageSurface>
  );
}

function CompanyCard({
  suggestion,
  picked,
  cursor,
  onToggle,
}: {
  suggestion: Suggestion;
  picked: boolean;
  cursor: boolean;
  onToggle: () => void;
}) {
  const colors = useThemeColors();
  const accent = colors.borderFocused;
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      minWidth={0}
      onMouseDown={onToggle}
      data-gloom-role="company-card"
      style={{
        position: "relative",
        gap: 10,
        height: 54,
        padding: "0 12px",
        borderRadius: 9,
        cursor: "pointer",
        boxSizing: "border-box",
        backgroundColor: picked
          ? `color-mix(in srgb, ${accent} 12%, ${blendHex(colors.panel, colors.bg, 0.12)})`
          : blendHex(colors.panel, colors.textBright, 0.025),
        boxShadow: picked
          ? `inset 0 0 0 1.5px ${accent}`
          : `inset 0 0 0 1px color-mix(in srgb, ${colors.textBright} 9%, transparent)`,
        outline: cursor ? `2px solid color-mix(in srgb, ${accent} 70%, transparent)` : "none",
        outlineOffset: 2,
        transition: "background-color 120ms ease, box-shadow 120ms ease",
      }}
    >
      <LogoTile symbol={suggestion.ticker} assetCategory={suggestion.assetCategory} size={30} />
      <Box flexDirection="column" minWidth={0} flexGrow={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD} style={{ fontSize: 13, lineHeight: "17px" }}>
          {suggestion.ticker}
        </Text>
        <Text
          fg={colors.textMuted}
          style={{ fontSize: 11, lineHeight: "15px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {suggestion.name}
        </Text>
      </Box>
      {picked ? (
        <Box
          alignItems="center"
          justifyContent="center"
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: accent,
          }}
        >
          <Icon name="check" size={10} color={colors.bg} />
        </Box>
      ) : null}
    </Box>
  );
}

export function CompanyPicker({
  searchCompanies,
  onDone,
}: {
  searchCompanies: SearchCompanies;
  onDone: (picks: CompanyPick[]) => void;
}) {
  useAppLanguage();
  const colors = useThemeColors();
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const keybindings = useKeybindings();
  const [picks, setPicks] = useState<CompanyPick[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InstrumentSearchResult[]>([]);
  const [resultIndex, setResultIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const searchSeq = useRef(0);
  const inputRef = useRef<InputRenderable | null>(null);
  const picked = useMemo(() => new Set(picks.map((pick) => pick.symbol)), [picks]);
  const ready = picks.length >= MIN_COMPANY_PICKS;

  const toggle = useCallback((pick: CompanyPick) => {
    setPicks((current) => current.some((entry) => entry.symbol === pick.symbol)
      ? current.filter((entry) => entry.symbol !== pick.symbol)
      : [...current, pick]);
  }, []);
  const toggleSuggestion = useCallback((suggestion: Suggestion) => {
    toggle({ symbol: suggestion.ticker, name: suggestion.name, seed: suggestion });
    // A click on a card keeps typing in the search.
    setTimeout(() => inputRef.current?.focus?.(), 0);
  }, [toggle]);

  const addResult = useCallback((result: InstrumentSearchResult) => {
    const symbol = getSearchResultSymbol(result);
    setPicks((current) => current.some((entry) => entry.symbol === symbol)
      ? current
      : [...current, { symbol, name: result.name || symbol, result }]);
    setQuery("");
    setResults([]);
  }, []);

  // Search as you type, debounced, newest answer wins.
  useEffect(() => {
    const text = query.trim();
    const seq = ++searchSeq.current;
    if (!text) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void searchCompanies(text)
        .then((found) => {
          if (searchSeq.current !== seq) return;
          const seen = new Set<string>();
          setResults(found.filter(isFollowableResult).filter((result) => {
            const symbol = getSearchResultSymbol(result);
            if (seen.has(symbol)) return false;
            seen.add(symbol);
            return true;
          }).slice(0, SEARCH_RESULTS));
          setResultIndex(0);
        })
        .catch(() => {
          if (searchSeq.current === seq) setResults([]);
        })
        .finally(() => {
          if (searchSeq.current === seq) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, searchCompanies]);

  const showingResults = query.trim().length > 0;
  const finish = useCallback(() => {
    if (ready) onDone(picks);
  }, [onDone, picks, ready]);

  // Required, so nothing behind the card takes a key. Arrows walk the grid
  // (or the results while searching), Space picks, Enter adds or finishes.
  useShortcut((event) => {
    const handled = ((): boolean => {
      if (showingResults) {
        if (isPlainKey(event, "down")) { setResultIndex((index) => Math.min(results.length - 1, index + 1)); return true; }
        if (isPlainKey(event, "up")) { setResultIndex((index) => Math.max(0, index - 1)); return true; }
        if (isPlainKey(event, "enter", "return")) {
          const result = results[resultIndex];
          if (result) addResult(result);
          return true;
        }
        if (isPlainKey(event, "escape")) { setQuery(""); return true; }
        return false;
      }
      const move = (delta: number) => {
        setCursor((current) => {
          const next = (current ?? -delta) + delta;
          return Math.max(0, Math.min(COMPANY_SUGGESTIONS.length - 1, next));
        });
        return true;
      };
      if (isPlainKey(event, "right")) return move(1);
      if (isPlainKey(event, "left")) return move(-1);
      if (isPlainKey(event, "down")) return move(desktop ? GRID_COLUMNS : 6);
      if (isPlainKey(event, "up")) return move(desktop ? -GRID_COLUMNS : -6);
      if (isPlainKey(event, "space", " ") && cursor !== null) {
        const suggestion = COMPANY_SUGGESTIONS[cursor];
        if (suggestion) toggleSuggestion(suggestion);
        return true;
      }
      if (isPlainKey(event, "enter", "return")) {
        if (ready) finish();
        else if (cursor !== null && COMPANY_SUGGESTIONS[cursor]) toggleSuggestion(COMPANY_SUGGESTIONS[cursor]!);
        return true;
      }
      // Required: Esc does not skip it.
      return isPlainKey(event, "escape");
    })();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (keyReachesPastOnboardingModal(event, keybindings)) return;
    event.stopPropagation();
  }, { phase: "before", allowEditable: true, scope: "company-picker" });

  const resultItems: ListViewItem[] = results.map((result) => {
    const symbol = getSearchResultSymbol(result);
    return {
      id: `${symbol}:${result.exchange}`,
      label: symbol,
      description: result.name,
      detail: picked.has(symbol) ? t("Picked") : result.exchange,
    };
  });

  const field = (
    <TextField
      value={query}
      placeholder={t("Search any company or ticker")}
      focused
      inputRef={inputRef}
      variant={desktop ? "plain" : "default"}
      {...(desktop ? {} : { label: t("Search"), labelWidth: 8, width: 62 })}
      onChange={(value) => setQuery(value)}
    />
  );
  // The DOM card draws its own frame so the text sits off the edge.
  const search = desktop ? (
    <Box
      flexDirection="row"
      alignItems="center"
      style={{
        height: 38,
        padding: "0 12px",
        gap: 10,
        borderRadius: 8,
        boxSizing: "border-box",
        backgroundColor: colors.bg,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${colors.textBright} 14%, transparent)`,
      }}
    >
      <Icon name="search" size={13} color={colors.textMuted} />
      <Box flexGrow={1} minWidth={0}>{field}</Box>
    </Box>
  ) : field;

  const hint = (
    <Text fg={ready ? colors.text : colors.textMuted} style={desktop ? { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } : undefined}>
      {selectionHint(picks)}
    </Text>
  );
  const continueButton = (
    <OnboardingButton
      label={ready ? tf("Follow {count} companies", { count: picks.length }) : t("Continue")}
      variant="primary"
      disabled={!ready}
      onPress={finish}
    />
  );

  if (desktop) {
    return (
      <OnboardingModal desktopWidth="min(660px, 100%)">
        <OnboardingTitle
          standalone
          title={t("Which companies do you follow?")}
          description={t("Your watchlist, alerts and Monday brief will follow them.")}
        />
        <Box flexDirection="column" style={{ marginTop: 18 }}>
          {search}
        </Box>
        <Box flexDirection="column" style={{ marginTop: 14, minHeight: 4 * 54 + 3 * 8 }}>
          {showingResults ? (
            results.length > 0 ? (
              <ListView
                items={resultItems}
                selectedIndex={resultIndex}
                onSelect={setResultIndex}
                onActivate={(_item, index) => {
                  const result = results[index];
                  if (result) addResult(result);
                }}
                surface="framed"
                rowGap={0}
                rowHeight={2}
                selectOnHover
                renderRow={(item, _state, index) => {
                  const result = results[index];
                  return (
                    <Box flexDirection="row" alignItems="center" width="100%" minWidth={0} style={{ gap: 10 }}>
                      <LogoTile symbol={item.label} assetCategory={result?.type} size={24} />
                      <Text fg={colors.textBright} attributes={TextAttributes.BOLD} style={{ minWidth: 64 }}>{item.label}</Text>
                      <Text
                        fg={colors.textMuted}
                        style={{ flexGrow: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                      >
                        {item.description}
                      </Text>
                      <Text fg={picked.has(item.label) ? colors.borderFocused : colors.textDim}>{item.detail}</Text>
                    </Box>
                  );
                }}
              />
            ) : (
              <Text fg={colors.textMuted} style={{ padding: "8px 2px" }}>
                {searching ? t("Searching…") : tf("No company matches {query}.", { query: query.trim() })}
              </Text>
            )
          ) : (
            <Box style={{ display: "grid", gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`, gap: 8 }}>
              {COMPANY_SUGGESTIONS.map((suggestion, index) => (
                <CompanyCard
                  key={suggestion.ticker}
                  suggestion={suggestion}
                  picked={picked.has(suggestion.ticker)}
                  cursor={cursor === index}
                  onToggle={() => toggleSuggestion(suggestion)}
                />
              ))}
            </Box>
          )}
        </Box>
        <OnboardingActions hint={hint}>{continueButton}</OnboardingActions>
      </OnboardingModal>
    );
  }

  // Terminal: the same steps on the cell grid, suggestions as a chip grid.
  const rows: Suggestion[][] = [];
  for (let index = 0; index < COMPANY_SUGGESTIONS.length; index += 6) {
    rows.push(COMPANY_SUGGESTIONS.slice(index, index + 6));
  }
  return (
    <OnboardingModal width={70} height={23}>
      <OnboardingTitle
        title={t("Which companies do you follow?")}
        description={t("Your watchlist, alerts and Monday brief will follow them.")}
      />
      <Box height={1} />
      {search}
      <Box height={1} />
      {showingResults ? (
        <Box flexDirection="column" height={6}>
          {results.length > 0 ? results.map((result, index) => {
            const symbol = getSearchResultSymbol(result);
            const selected = index === resultIndex;
            return (
              <Box
                key={`${symbol}:${result.exchange}`}
                height={1}
                flexDirection="row"
                backgroundColor={selected ? colors.selected : undefined}
                onMouseDown={() => addResult(result)}
              >
                <Text fg={selected ? colors.textBright : colors.text} attributes={TextAttributes.BOLD}>{symbol.padEnd(10)}</Text>
                <Text fg={colors.textMuted}>{result.name}</Text>
              </Box>
            );
          }) : (
            <Text fg={colors.textMuted}>{searching ? t("Searching…") : tf("No company matches {query}.", { query: query.trim() })}</Text>
          )}
        </Box>
      ) : (
        <Box flexDirection="column" height={6}>
          {rows.map((row, rowIndex) => (
            <Box key={rowIndex} flexDirection="row" gap={1} height={1} marginBottom={rowIndex < rows.length - 1 ? 1 : 0}>
              {row.map((suggestion, column) => {
                const index = rowIndex * 6 + column;
                return (
                  <Button
                    key={suggestion.ticker}
                    label={`${picked.has(suggestion.ticker) ? "✓" : " "}${suggestion.ticker}`}
                    title={suggestion.name}
                    variant={picked.has(suggestion.ticker) ? "primary" : cursor === index ? "secondary" : "ghost"}
                    active={picked.has(suggestion.ticker) || cursor === index}
                    compact
                    onPress={() => toggleSuggestion(suggestion)}
                  />
                );
              })}
            </Box>
          ))}
        </Box>
      )}
      <Box height={1} />
      <Box height={1}>{hint}</Box>
      <Box height={1} />
      <OnboardingActions>{continueButton}</OnboardingActions>
    </OnboardingModal>
  );
}

/**
 * Mounted next to the onboarding. Opens once per session, when a brand-new
 * account is signed in with only the seeded lists and the onboarding is not
 * running.
 */
export function CompanyPickerHost({ pluginRegistry }: { pluginRegistry: PluginRegistry }) {
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const toast = useToastHost();
  const onboardingDone = useAppSelector((state) => state.config.onboardingComplete && !state.config.onboardingProgress);
  const [user, setUser] = useState<AuthUser | null>(() => apiClient.getCurrentUser());
  const [open, setOpen] = useState(false);
  const askedRef = useRef(false);

  useEffect(() => apiClient.subscribeCurrentUser(() => setUser(apiClient.getCurrentUser())), []);

  useEffect(() => {
    if (askedRef.current || !onboardingDone || !isNewAccount(user)) return;
    const watchlistId = stateRef.current.config.watchlists[0]?.id;
    if (!needsCompanyPicks(stateRef.current.tickers.values(), watchlistId)) return;
    askedRef.current = true;
    setOpen(true);
  }, [onboardingDone, stateRef, user]);

  const searchCompanies = useCallback<SearchCompanies>(
    (query) => pluginRegistry.marketData.search(query),
    [pluginRegistry],
  );

  const save = useCallback(async (picks: CompanyPick[]) => {
    setOpen(false);
    // Search results go through the usual upsert so they get their listing and contract.
    for (const pick of picks) {
      if (!pick.result || stateRef.current.tickers.has(pick.symbol)) continue;
      try {
        const { ticker } = await upsertTickerFromSearchResult(pluginRegistry.tickerRepository, pick.result);
        dispatch({ type: "UPDATE_TICKER", ticker });
        pick.symbol = ticker.metadata.ticker;
      } catch (error) {
        log.error("Could not save a searched ticker", { symbol: pick.symbol, error: String(error) });
      }
    }
    const listId = stateRef.current.config.watchlists[0]?.id ?? "watchlist";
    const plan = planCompanyPicks(stateRef.current.tickers, listId, picks);
    for (const metadata of plan.create) {
      try {
        const ticker = await pluginRegistry.tickerRepository.createTicker(metadata);
        dispatch({ type: "UPDATE_TICKER", ticker });
        pluginRegistry.events.emit("ticker:added", { symbol: ticker.metadata.ticker, ticker });
      } catch (error) {
        log.error("Could not create a picked ticker", { symbol: metadata.ticker, error: String(error) });
      }
    }
    for (const ticker of plan.update) {
      try {
        await pluginRegistry.tickerRepository.saveTicker(ticker);
        dispatch({ type: "UPDATE_TICKER", ticker });
      } catch (error) {
        log.error("Could not update the watchlist", { symbol: ticker.metadata.ticker, error: String(error) });
      }
    }
    toast.success(tf("Following {count} companies. Alerts and your Monday brief will cover them.", { count: picks.length }));
  }, [dispatch, pluginRegistry, stateRef, toast]);

  if (!open) return null;
  return <CompanyPicker searchCompanies={searchCompanies} onDone={(picks) => { void save(picks); }} />;
}
