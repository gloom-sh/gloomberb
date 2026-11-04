import { createElement, useCallback, useRef, type ReactNode } from "react";
import { TextPromptDialog } from "../../../../components";
import { t, tf } from "../../../../i18n";
import { findNamedCollection } from "../../../../portfolio/collection-name";
import { createManualPortfolio, isManualPortfolio } from "../../../../portfolio/mutations";
import { defaultImportPortfolioName, positionsImportSource } from "../../../../portfolio/positions-import/describe";
import { parsePositionsFile, POSITIONS_EXPORT_BROKERS, PositionsFileError } from "../../../../portfolio/positions-import/parse";
import { applyPositionsImportPlan, type PositionsImportPlan } from "../../../../portfolio/positions-import/plan";
import { syncConfigActiveLayoutState, useAppDispatch, useAppStateRef } from "../../../../state/app/context";
import { scheduleConfigSave } from "../../../../state/config-save-scheduler";
import type { AppConfig } from "../../../../types/config";
import type { Portfolio, TickerRecord } from "../../../../types/ticker";
import { useUiCapabilities } from "../../../../ui";
import { useDialog } from "../../../../ui/dialog";
import { logFailure } from "../../../../utils/log-failure";
import { getSharedRegistry } from "../../../registry";
import { usePluginAppActions } from "../../../runtime";
import {
  POSITIONS_IMPORT_DIALOG_COLUMNS,
  PositionsImportDialog,
  type PositionsImportPreview,
  type PositionsImportTarget,
} from "./dialog";
import { lookUpPositionSymbols, type PositionSymbolLookup } from "./lookup";
import { MAX_POSITIONS_FILE_BYTES, readPositionsFilePath } from "./read-file";

/** The terminal dialog's border and padding, around the preview's columns. */
const TERMINAL_DIALOG_INSET = 6;
/** What the system file dialog offers: the formats brokers export positions in. */
const POSITIONS_FILE_TYPES = ".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain";

interface FileInputLike {
  click(): void;
  value: string;
  files: ArrayLike<File> | null;
}

/** A new portfolio's name, numbered past the ones taken: Fidelity, then Fidelity 2. */
function newPortfolioFor(config: AppConfig, name: string): { config: AppConfig; portfolio: Portfolio } {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return createManualPortfolio(config, attempt === 1 ? name : `${name} ${attempt}`, config.baseCurrency);
    } catch (error) {
      if (attempt >= 50) throw error;
    }
  }
}

function holdingsOf(tickers: ReadonlyMap<string, TickerRecord>, portfolioId: string): TickerRecord[] {
  return [...tickers.values()].filter((ticker) => ticker.metadata.portfolios.includes(portfolioId));
}

/**
 * Importing a broker's positions export into a portfolio, from the PF pane:
 * the desktop and the web pick the file with the system dialog, the terminal
 * asks for its path. The file is previewed before anything is saved.
 * `picker` is the desktop's hidden file input, for the pane to render.
 */
export function usePositionsImport({
  activePortfolio,
  onImported,
}: {
  /** The pane's portfolio, offered to merge into or replace when it is a manual one. */
  activePortfolio: Portfolio | null;
  /** The portfolio the positions went into, to show it. */
  onImported: (portfolioId: string) => void;
}): { start: () => void; picker: ReactNode } {
  const dialog = useDialog();
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const { notify } = usePluginAppActions();
  const { nativePaneChrome } = useUiCapabilities();
  const inputRef = useRef<FileInputLike | null>(null);
  const activeRef = useRef(activePortfolio);
  activeRef.current = activePortfolio;
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;

  const preview = useCallback(async (text: string, fileName: string) => {
    const registry = getSharedRegistry();
    if (!registry) {
      notify({ type: "error", body: t("Ticker lookup unavailable.") });
      return;
    }
    let file;
    try {
      file = parsePositionsFile(text);
    } catch (error) {
      if (!(error instanceof PositionsFileError)) throw error;
      notify({ type: "error", body: `${fileName}: ${error.message}` });
      return;
    }
    const state = stateRef.current;
    const config = state.config;
    const defaultName = defaultImportPortfolioName(file.layout, fileName);
    const active = activeRef.current && isManualPortfolio(activeRef.current) ? activeRef.current : null;
    const named = findNamedCollection(config.portfolios, defaultName);
    const existingPortfolio = active ?? (named && isManualPortfolio(named) ? named : null);
    const existing = existingPortfolio ? { portfolio: existingPortfolio, holdings: holdingsOf(state.tickers, existingPortfolio.id) } : null;
    const newPortfolio = newPortfolioFor(config, defaultName).portfolio;
    // An empty portfolio or the broker's own takes the file; another one keeps what it holds unless asked.
    const sameBroker = existingPortfolio?.name.toLowerCase() === defaultName.toLowerCase();
    const initialTarget: PositionsImportTarget = existing && (existing.holdings.length === 0 || sameBroker) ? "merge" : "new";
    const importPreview: PositionsImportPreview = {
      file,
      source: positionsImportSource(file.layout, fileName),
      newPortfolio,
      existing,
      initialTarget,
      baseCurrency: config.baseCurrency,
    };
    const symbols = file.positions.map((position) => position.symbol);
    const lookUp = () => lookUpPositionSymbols(symbols, {
      tickers: stateRef.current.tickers,
      store: registry.tickerRepository,
      dataProvider: registry.marketData,
    });

    const commit = async (plan: PositionsImportPlan, lookup: PositionSymbolLookup, target: PositionsImportTarget) => {
      const current = stateRef.current;
      let nextConfig = current.config;
      let portfolio: Portfolio;
      if (target === "new" || !existing) {
        const created = newPortfolioFor(nextConfig, newPortfolio.name);
        nextConfig = created.config;
        portfolio = created.portfolio;
      } else {
        portfolio = existing.portfolio;
      }
      const holdings = target === "new" ? [] : holdingsOf(current.tickers, portfolio.id);
      const applied = applyPositionsImportPlan(plan, {
        portfolioId: portfolio.id,
        config: nextConfig,
        holdings,
        current: (key) => current.tickers.get(key),
      });
      const savedConfig = applied.config ?? (nextConfig === current.config ? null : nextConfig);
      if (savedConfig) {
        dispatch({ type: "SET_CONFIG", config: savedConfig });
        scheduleConfigSave(syncConfigActiveLayoutState(savedConfig, current.paneState, current.focusedPaneId));
      }
      for (const ticker of applied.tickers) {
        await registry.tickerRepository.saveTicker(ticker);
        dispatch({ type: "UPDATE_TICKER", ticker });
        if (lookup.unsaved.has(ticker.metadata.ticker) && !current.tickers.has(ticker.metadata.ticker)) {
          registry.events.emit("ticker:added", { symbol: ticker.metadata.ticker, ticker });
        }
      }
      onImportedRef.current(portfolio.id);
      const count = plan.rows.length === 1 ? t("1 position") : tf("{count} positions", { count: plan.rows.length });
      notify({ type: "success", body: tf("Imported {count} into \"{name}\".", { count, name: portfolio.name }) });
    };

    await dialog.prompt<boolean>({
      closeOnClickOutside: false,
      style: { width: POSITIONS_IMPORT_DIALOG_COLUMNS + TERMINAL_DIALOG_INSET },
      content: (context) => <PositionsImportDialog {...context} preview={importPreview} lookUp={lookUp} commit={commit} />,
    });
  }, [dialog, dispatch, notify, stateRef]);

  const fail = useCallback((error: unknown) => {
    logFailure("portfolio-list.positions-import", "Import positions failed")(error);
    notify({ type: "error", body: error instanceof Error && error.message ? error.message : t("Could not read that file.") });
  }, [notify]);

  const askForPath = useCallback(async () => {
    const path = await dialog.prompt<string>({
      size: "large",
      content: (context) => (
        <TextPromptDialog
          {...context}
          title="Import Positions"
          body={[tf("A positions or holdings CSV from {brokers}, or any table with Symbol and Quantity columns.", {
            brokers: POSITIONS_EXPORT_BROKERS.join(", "),
          })]}
          label="File"
          placeholder="~/Downloads/Positions.csv"
          confirmLabel="Preview"
          footer={t("Enter preview · Esc cancel")}
        />
      ),
    });
    if (!path) return;
    const read = await readPositionsFilePath(path);
    await preview(read.text, read.name);
  }, [dialog, preview]);

  const start = useCallback(() => {
    if (nativePaneChrome) {
      inputRef.current?.click();
      return;
    }
    askForPath().catch(fail);
  }, [askForPath, fail, nativePaneChrome]);

  const picker = nativePaneChrome ? createElement("input", {
    ref: (node: FileInputLike | null) => { inputRef.current = node; },
    type: "file",
    accept: POSITIONS_FILE_TYPES,
    tabIndex: -1,
    "aria-hidden": true,
    "data-gloom-role": "positions-import-input",
    style: { display: "none" },
    onChange: (event: { currentTarget: FileInputLike }) => {
      const input = event.currentTarget;
      const picked = input.files?.[0];
      // Cleared so picking the same file again still fires a change.
      input.value = "";
      if (!picked) return;
      if (picked.size > MAX_POSITIONS_FILE_BYTES) {
        notify({ type: "error", body: tf("{name} is too large to be a positions export.", { name: picked.name }) });
        return;
      }
      picked.text().then((text) => preview(text, picked.name)).catch(fail);
    },
  }) : null;

  return { start, picker };
}
