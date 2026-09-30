/**
 * "Pick a few companies to follow", asked once of a brand-new account whose
 * lists are still the ones the app seeded. Alerts on the seeded tickers bring
 * about 3.5% of idle people back, against 8.8% for tickers they chose and
 * 13.5% for positions, and the Monday brief only covers chosen tickers. So
 * the picks go on the watchlist and the seeded names nobody picked come off:
 * the list becomes theirs, and the server can tell (fewer than 7 starters
 * left means the list was made by hand).
 *
 * The native onboarding already asks for a holding or a followed company, so
 * this is for everyone who signs up without it, which is most people: the web
 * terminal and sign-ups from gloom.sh.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient, type AuthUser } from "../../../api-client";
import { Button } from "../../../components/ui/button";
import { TextField } from "../../../components/ui/fields";
import { DialogFrame } from "../../../components/ui/frame";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { useViewport } from "../../../react/input";
import { useAppDispatch, useAppSelector, useAppStateRef } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import { resolveTickerSearch } from "../../../tickers/search";
import { upsertTickerFromSearchResult } from "../../../tickers/search/upsert";
import type { TickerMetadata, TickerRecord } from "../../../types/ticker";
import { Box, Text } from "../../../ui";
import { type DialogApi, type PromptContext, useDialogKeyboard, useOptionalDialog } from "../../../ui/dialog";
import { useToastHost } from "../../../ui/toast";
import { debugLog } from "../../../utils/debug-log";
import type { PluginRegistry } from "../../registry";

const log = debugLog.createLogger("company-picker");

export const MIN_COMPANY_PICKS = 2;
/** Only accounts this new are asked; nobody who has used Gloom for a while. */
const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;
/** The seeded lists hold 7 (web first run) or 12 (startup) starter tickers. */
const SEEDED_LIST_MIN_STARTERS = 7;

/**
 * Every ticker the app seeds: `DEFAULT_WATCHLIST_TICKERS` in
 * src/state/app/bootstrap.ts and `FIRST_RUN_WATCHLIST` in
 * src/components/onboarding/first-run-workspace.ts. A test keeps them equal.
 */
export const STARTER_SYMBOLS: ReadonlySet<string> = new Set([
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "TSLA", "META", "BRK.B", "JPM", "V", "BTC-USD", "ETH-USD", "SPY", "QQQ",
]);

type Suggestion = Pick<TickerMetadata, "ticker" | "name" | "exchange" | "assetCategory" | "currency">;

/** What people most often follow, big names first, then an index fund and bitcoin. */
export const COMPANY_SUGGESTIONS: readonly Suggestion[] = [
  { ticker: "NVDA", name: "NVIDIA Corp.", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "MSFT", name: "Microsoft Corp.", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "TSLA", name: "Tesla Inc.", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "AMZN", name: "Amazon.com Inc.", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "META", name: "Meta Platforms Inc.", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "GOOGL", name: "Alphabet Inc.", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "AMD", name: "Advanced Micro Devices Inc.", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "PLTR", name: "Palantir Technologies Inc.", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "AVGO", name: "Broadcom Inc.", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "NFLX", name: "Netflix Inc.", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "COIN", name: "Coinbase Global Inc.", exchange: "NASDAQ", assetCategory: "STK", currency: "USD" },
  { ticker: "JPM", name: "JPMorgan Chase & Co.", exchange: "NYSE", assetCategory: "STK", currency: "USD" },
  { ticker: "BRK.B", name: "Berkshire Hathaway Inc.", exchange: "NYSE", assetCategory: "STK", currency: "USD" },
  { ticker: "SPY", name: "SPDR S&P 500 ETF", exchange: "NYSEARCA", assetCategory: "ETF", currency: "USD" },
  { ticker: "BTC-USD", name: "Bitcoin USD", exchange: "CCC", assetCategory: "CRYPTO", currency: "USD" },
];

export interface CompanyPick {
  symbol: string;
  name: string;
  /** A suggestion's metadata, for a ticker the app does not have yet. */
  seed?: Suggestion;
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

type ResolveQuery = (query: string) => Promise<CompanyPick | null>;

export function CompanyPickerDialog({
  dialogId,
  resolve,
  resolveQuery,
  width,
}: PromptContext<CompanyPick[]> & { resolveQuery: ResolveQuery; width: number }) {
  useAppLanguage();
  const colors = useThemeColors();
  const [picks, setPicks] = useState<CompanyPick[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<{ tone: "muted" | "error"; text: string } | null>(null);
  const [looking, setLooking] = useState(false);
  const picksRef = useRef(picks);
  picksRef.current = picks;

  const toggle = useCallback((pick: CompanyPick) => {
    setStatus(null);
    setPicks((current) => current.some((entry) => entry.symbol === pick.symbol)
      ? current.filter((entry) => entry.symbol !== pick.symbol)
      : [...current, pick]);
  }, []);

  const confirm = useCallback(() => {
    if (picksRef.current.length < MIN_COMPANY_PICKS) {
      setStatus({ tone: "error", text: tf("Pick at least {count}.", { count: MIN_COMPANY_PICKS }) });
      return;
    }
    resolve(picksRef.current);
  }, [resolve]);

  // Enter adds what is typed; on an empty field it finishes.
  const submitQuery = useCallback(async (value: string) => {
    const typed = value.replace(/^\s*\$/, "").trim();
    if (!typed) {
      confirm();
      return;
    }
    setLooking(true);
    setStatus({ tone: "muted", text: t("Looking up…") });
    try {
      const found = await resolveQuery(typed);
      if (!found) {
        setStatus({ tone: "error", text: tf("No ticker matches {query}.", { query: typed.toUpperCase() }) });
        return;
      }
      setQuery("");
      setStatus(null);
      if (!picksRef.current.some((entry) => entry.symbol === found.symbol)) {
        setPicks((current) => [...current, found]);
      }
    } catch {
      setStatus({ tone: "error", text: t("Ticker lookup failed.") });
    } finally {
      setLooking(false);
    }
  }, [confirm, resolveQuery]);

  // Required: Esc does not skip it. Keys other than the field's own go nowhere.
  useDialogKeyboard((event) => {
    if (event.name === "escape") event.stopPropagation?.();
  }, { scope: dialogId, allowEditable: true });

  const pickedSymbols = new Set(picks.map((pick) => pick.symbol));
  const chipsPerRow = Math.max(3, Math.floor(width / 10));
  const rows: Suggestion[][] = [];
  for (let index = 0; index < COMPANY_SUGGESTIONS.length; index += chipsPerRow) {
    rows.push(COMPANY_SUGGESTIONS.slice(index, index + chipsPerRow));
  }
  const extra = picks.filter((pick) => !COMPANY_SUGGESTIONS.some((entry) => entry.ticker === pick.symbol));
  const remaining = Math.max(0, MIN_COMPANY_PICKS - picks.length);

  return (
    <DialogFrame
      title={t("Pick a few companies to follow")}
      subtitle={t("Your watchlist, alerts and Monday brief will follow them. You can change them anytime.")}
      footer={t("Click to pick · type a ticker, Enter to add · Enter when done")}
    >
      <Box flexDirection="column" width={width}>
        {rows.map((row, index) => (
          <Box key={index} flexDirection="row" gap={1} height={1} marginBottom={index < rows.length - 1 ? 1 : 0}>
            {row.map((suggestion) => (
              <Button
                key={suggestion.ticker}
                label={suggestion.ticker}
                title={suggestion.name}
                variant={pickedSymbols.has(suggestion.ticker) ? "primary" : "secondary"}
                active={pickedSymbols.has(suggestion.ticker)}
                compact
                onPress={() => toggle({ symbol: suggestion.ticker, name: suggestion.name, seed: suggestion })}
              />
            ))}
          </Box>
        ))}
        <Box height={1} />
        <TextField
          label={t("Another ticker")}
          labelWidth={16}
          value={query}
          placeholder={t("e.g. SHOP, ASML, 7203.T")}
          focused
          width={width}
          onChange={(value) => {
            setStatus(null);
            setQuery(value.toUpperCase());
          }}
          onSubmit={(value) => { void submitQuery(value); }}
        />
        <Box height={1} />
        {extra.length > 0 ? (
          <Box flexDirection="row" gap={1} height={1} marginBottom={1}>
            {extra.map((pick) => (
              <Button key={pick.symbol} label={pick.symbol} title={pick.name} variant="primary" active compact onPress={() => toggle(pick)} />
            ))}
          </Box>
        ) : null}
        <Box height={1}>
          {status ? (
            <Text fg={status.tone === "error" ? colors.negative : colors.textMuted}>{status.text}</Text>
          ) : (
            <Text fg={colors.textMuted}>
              {picks.length === 0
                ? tf("Pick at least {count}.", { count: MIN_COMPANY_PICKS })
                : remaining > 0
                  ? tf("{count} more to go.", { count: remaining })
                  : tf("{count} picked.", { count: picks.length })}
            </Text>
          )}
        </Box>
        <Box height={1} />
        <Box flexDirection="row">
          <Button
            label={picks.length >= MIN_COMPANY_PICKS
              ? tf("Follow {count} companies", { count: picks.length })
              : t("Follow these companies")}
            variant="primary"
            disabled={picks.length < MIN_COMPANY_PICKS || looking}
            onPress={confirm}
          />
        </Box>
      </Box>
    </DialogFrame>
  );
}

const CONTENT_WIDTH = 64;
const TERMINAL_DIALOG_CHROME = 6;

export async function promptCompanyPicks(
  dialog: DialogApi,
  resolveQuery: ResolveQuery,
  viewportWidth: number,
): Promise<CompanyPick[] | null> {
  const width = Math.max(40, Math.min(CONTENT_WIDTH, viewportWidth - TERMINAL_DIALOG_CHROME - 4));
  const picks = await dialog.prompt<CompanyPick[]>({
    closeOnEscape: false,
    closeOnClickOutside: false,
    style: { width: width + TERMINAL_DIALOG_CHROME },
    content: (context) => <CompanyPickerDialog {...context} resolveQuery={resolveQuery} width={width} />,
  }).catch(() => undefined);
  return picks && picks.length > 0 ? picks : null;
}

/**
 * Mounted by the shell. Asks once per session, when a brand-new account is
 * signed in with only the seeded lists and the onboarding is not running.
 */
export function CompanyPickerHost({ pluginRegistry }: { pluginRegistry: PluginRegistry }) {
  const dialog = useOptionalDialog();
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const toast = useToastHost();
  const viewport = useViewport();
  const onboardingDone = useAppSelector((state) => state.config.onboardingComplete && !state.config.onboardingProgress);
  const [user, setUser] = useState<AuthUser | null>(() => apiClient.getCurrentUser());
  const askedRef = useRef(false);

  useEffect(() => apiClient.subscribeCurrentUser(() => setUser(apiClient.getCurrentUser())), []);

  const resolveQuery = useCallback<ResolveQuery>(async (query) => {
    const resolved = await resolveTickerSearch({
      query,
      activeTicker: null,
      tickers: stateRef.current.tickers,
      dataProvider: pluginRegistry.marketData,
    });
    if (!resolved) return null;
    if (resolved.kind === "local") {
      return { symbol: resolved.ticker.metadata.ticker, name: resolved.ticker.metadata.name || resolved.ticker.metadata.ticker };
    }
    const { ticker } = await upsertTickerFromSearchResult(pluginRegistry.tickerRepository, resolved.result);
    dispatch({ type: "UPDATE_TICKER", ticker });
    return { symbol: ticker.metadata.ticker, name: ticker.metadata.name || ticker.metadata.ticker };
  }, [dispatch, pluginRegistry, stateRef]);

  useEffect(() => {
    if (!dialog || askedRef.current || !onboardingDone || !isNewAccount(user)) return;
    const watchlistId = stateRef.current.config.watchlists[0]?.id;
    if (!needsCompanyPicks(stateRef.current.tickers.values(), watchlistId)) return;
    askedRef.current = true;
    void (async () => {
      const picks = await promptCompanyPicks(dialog, resolveQuery, viewport.width);
      if (!picks) return;
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
    })();
  }, [dialog, dispatch, onboardingDone, pluginRegistry, resolveQuery, stateRef, toast, user, viewport.width]);

  return null;
}
