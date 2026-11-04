import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  DataTableView,
  DialogFrame,
  FieldLabel,
  Notice,
  SectionHeading,
  SegmentedControl,
  Spinner,
  type DataTableCell,
  type DataTableColumn,
} from "../../../../components";
import { DialogActions } from "../../../../components/ui/dialog-actions";
import { fitDialogWidth } from "../../../../components/ui/frame";
import { t, tf } from "../../../../i18n";
import {
  morePositionsLine,
  moreSkippedLine,
  PREVIEW_ROWS_SHOWN,
  positionsImportCost,
  positionsImportShares,
  positionsImportShowsCurrency,
  positionsImportStatus,
} from "../../../../portfolio/positions-import/describe";
import type { PositionsFile, SkippedFileRow } from "../../../../portfolio/positions-import/parse";
import {
  buildPositionsImportPlan,
  replaceRefusal,
  summarizePositionsImport,
  type PositionsImportMode,
  type PositionsImportPlan,
  type PositionsImportRow,
} from "../../../../portfolio/positions-import/plan";
import { useViewport } from "../../../../react/input";
import { useThemeColors } from "../../../../theme/theme-context";
import type { Portfolio, TickerRecord } from "../../../../types/ticker";
import { Box, ScrollBox, Text, useUiCapabilities, type ScrollBoxRenderable } from "../../../../ui";
import { useDialogKeyboard, type PromptContext } from "../../../../ui/dialog";
import { canonicalExchange } from "../../../../utils/exchanges";
import { isPlainKey } from "../../../../utils/keyboard";
import { wrapTextLines } from "../../../../utils/text-wrap";
import type { PositionSymbolLookup } from "./lookup";

/** The body's width in cells: the positions table's six columns and a name that reads. */
export const POSITIONS_IMPORT_DIALOG_COLUMNS = 88;
/** Border and padding the terminal dialog draws around its content. */
const TERMINAL_DIALOG_INSET = 6;
/** The terminal body's scrollbar and the gap before it. */
const TERMINAL_SCROLLBAR_COLUMNS = 2;
/** Rows the terminal dialog spends outside the scrolling body: frame, title, subtitle, key line, buttons. */
const TERMINAL_CHROME_ROWS = 4 + 3 + 2 + 2;
const DESKTOP_MAX_HEIGHT = "calc(100vh - 50px)";

/** Where the positions go: a new portfolio, or the existing one merged into or replaced. */
export type PositionsImportTarget = "new" | PositionsImportMode;

export interface PositionsImportPreview {
  file: PositionsFile;
  /** Where the positions come from, after "from": "the Fidelity positions export", "holdings.csv". */
  source: string;
  /** The portfolio a new import makes. */
  newPortfolio: Portfolio;
  /** A manual portfolio the import can merge into or replace, with what it holds; null offers only a new one. */
  existing: { portfolio: Portfolio; holdings: TickerRecord[] } | null;
  initialTarget: PositionsImportTarget;
  baseCurrency: string;
}

/** What a replace asks before it saves. */
export interface PositionsImportConfirmation {
  title: string;
  body: string[];
  confirmLabel: string;
}

export interface PositionsImportDialogProps extends PromptContext<boolean> {
  preview: PositionsImportPreview;
  lookUp: () => Promise<PositionSymbolLookup>;
  /** Asks before a replace removes what the portfolio holds; true goes ahead. */
  confirm: (request: PositionsImportConfirmation) => Promise<boolean>;
  /** Saves the plan; a throw is shown in the dialog, which stays open. */
  commit: (plan: PositionsImportPlan, lookup: PositionSymbolLookup, target: PositionsImportTarget) => Promise<void>;
}

type PositionColumn = DataTableColumn & { id: "ticker" | "name" | "shares" | "cost" | "currency" | "bought" | "status" };
type SkippedColumn = DataTableColumn & { id: "line" | "row" | "reason" };

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t("Could not complete that action.");
}

function positionsCount(count: number): string {
  return count === 1 ? t("1 position") : tf("{count} positions", { count });
}

/** The line over the table: what the import does, as `portfolio import` heads its table. */
function planHeadline(plan: PositionsImportPlan, target: PositionsImportTarget, portfolioName: string): string {
  const summary = summarizePositionsImport(plan);
  const count = positionsCount(plan.rows.length);
  if (target === "new") return tf("Creates portfolio \"{name}\" with {count}.", { name: portfolioName, count });
  if (target === "replace" && summary.removed > 0) {
    return tf("Replaces the holdings of \"{name}\" with {count}, removing {removed}.", { name: portfolioName, count, removed: summary.removed });
  }
  if (summary.updated === 0) return tf("Adds {count} to \"{name}\".", { name: portfolioName, count });
  if (summary.added === 0) return tf("Updates {count} in \"{name}\".", { name: portfolioName, count });
  return tf("Imports {count} into \"{name}\": {added} new, {updated} updated.", {
    name: portfolioName, count, added: summary.added, updated: summary.updated,
  });
}

function tableRows(count: number): number {
  return count + 1;
}

function tickerList(tickers: readonly TickerRecord[]): string {
  return tickers.map((ticker) => ticker.metadata.ticker).join(", ");
}

function removedLine(tickers: readonly TickerRecord[]): string {
  return tf("Removes {tickers}: not in the file.", { tickers: tickerList(tickers) });
}

/** A replace leaves these as they are: the file names them, on rows it could not import. */
function keptLine(tickers: readonly TickerRecord[]): string {
  return tickers.length === 1
    ? tf("Keeps {ticker}: the file lists it on a skipped row.", { ticker: tickerList(tickers) })
    : tf("Keeps {tickers}: the file lists them on a skipped row.", { tickers: tickerList(tickers) });
}

/** The second step of a replace: what the portfolio holds after it, and what it loses. */
function replaceConfirmation(plan: PositionsImportPlan, portfolioName: string, heldCount: number): PositionsImportConfirmation {
  const held = heldCount === 1 ? t("1 ticker") : tf("{count} tickers", { count: heldCount });
  return {
    title: tf("Replace {name}?", { name: portfolioName }),
    body: [
      tf("\"{name}\" holds {held}. After the replace it holds the file's {count}.", { name: portfolioName, held, count: positionsCount(plan.rows.length) }),
      ...plan.removed.length > 0 ? [removedLine(plan.removed)] : [],
      ...plan.kept.length > 0 ? [keptLine(plan.kept)] : [],
    ],
    confirmLabel: t("Replace"),
  };
}

/**
 * The preview of a positions import: what each of the file's positions
 * becomes, what is left out and why, and, for a portfolio that exists,
 * whether the file merges into it or replaces it. Nothing is saved until
 * Import.
 */
export function PositionsImportDialog({ resolve, dialogId, preview, lookUp, confirm, commit }: PositionsImportDialogProps) {
  const colors = useThemeColors();
  const { nativePaneChrome: desktop } = useUiCapabilities();
  const viewport = useViewport();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [lookup, setLookup] = useState<PositionSymbolLookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [target, setTarget] = useState<PositionsImportTarget>(preview.initialTarget);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    lookUp().then(
      (result) => { if (live) setLookup(result); },
      (error: unknown) => { if (live) setLookupError(errorMessage(error)); },
    );
    return () => { live = false; };
  }, [lookUp]);

  const portfolio = target === "new" || !preview.existing ? preview.newPortfolio : preview.existing.portfolio;
  const plan = useMemo(() => lookup ? buildPositionsImportPlan({
    file: preview.file,
    resolutions: lookup.resolutions,
    portfolio,
    holdings: target === "new" ? [] : preview.existing?.holdings ?? [],
    mode: target === "replace" ? "replace" : "merge",
    baseCurrency: preview.baseCurrency,
  }) : null, [lookup, portfolio, preview, target]);
  const heldCount = preview.existing?.holdings.length ?? 0;
  const refusal = plan && target === "replace" ? replaceRefusal(plan) : null;
  const ready = !!plan && plan.rows.length > 0 && !refusal && !busy && !confirming;

  const submit = useCallback(async () => {
    if (!plan || !lookup || !ready) return;
    setSaveError(null);
    if (target === "replace") {
      setConfirming(true);
      let sure = false;
      try {
        sure = await confirm(replaceConfirmation(plan, portfolio.name, heldCount));
      } catch (error) {
        setSaveError(errorMessage(error));
      } finally {
        setConfirming(false);
      }
      if (!sure) return;
    }
    setBusy(true);
    try {
      await commit(plan, lookup, target);
      resolve(true);
    } catch (error) {
      setSaveError(errorMessage(error));
      setBusy(false);
    }
  }, [commit, confirm, heldCount, lookup, plan, portfolio.name, ready, resolve, target]);

  const scrollBy = useCallback((rows: number) => {
    const box = scrollRef.current;
    if (box) box.scrollTo(Math.max(0, box.scrollTop + rows));
  }, []);

  useDialogKeyboard((event) => {
    // The replace's confirm answers its own keys.
    if (confirming) return;
    if (event.name === "escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) resolve(false);
      return;
    }
    if (event.name === "enter" || event.name === "return") {
      event.preventDefault();
      event.stopPropagation();
      void submit();
      return;
    }
    const page = Math.max(1, (scrollRef.current?.viewport?.height ?? 10) - 1);
    const rows = isPlainKey(event, "down", "j") ? 1
      : isPlainKey(event, "up", "k") ? -1
        : isPlainKey(event, "pagedown") ? page
          : isPlainKey(event, "pageup") ? -page
            : 0;
    if (!rows) return;
    event.preventDefault();
    event.stopPropagation();
    scrollBy(rows);
  }, { allowEditable: true });

  const dated = !!plan?.rows.some((row) => row.dateAcquired);
  // As PF shows the currency column: once a row is in another currency than the portfolio totals in.
  const existingId = preview.existing?.portfolio.id;
  const totalsCurrency = target !== "new" && preview.existing?.holdings.some((ticker) => ticker.metadata.positions.some((position) => position.portfolio === existingId))
    ? portfolio.currency ?? preview.baseCurrency
    : null;
  const priced = !!plan && positionsImportShowsCurrency(plan.rows, totalsCurrency);
  const positionColumns = useMemo<PositionColumn[]>(() => [
    { id: "ticker", label: t("Ticker"), width: 13, align: "left" },
    { id: "name", label: t("Name"), width: 14, align: "left", flexGrow: 1 },
    { id: "shares", label: t("Shares"), width: 10, align: "right" },
    { id: "cost", label: t("Avg Cost"), width: 14, align: "right" },
    ...priced ? [{ id: "currency" as const, label: t("Ccy"), width: 4, align: "left" as const }] : [],
    ...dated ? [{ id: "bought" as const, label: t("Bought"), width: 11, align: "left" as const }] : [],
    { id: "status", label: t("Status"), width: 11, align: "left" },
  ], [dated, priced]);
  const skippedColumns = useMemo<SkippedColumn[]>(() => [
    { id: "line", label: t("Line"), width: 5, align: "right" },
    { id: "row", label: t("Row"), width: 24, align: "left" },
    { id: "reason", label: t("Reason"), width: 20, align: "left", flexGrow: 1 },
  ], []);

  const renderPosition = useCallback((row: PositionsImportRow, column: PositionColumn): DataTableCell => {
    switch (column.id) {
      // The venue says which listing the symbol went to: ASML.AS is ASML on AMS, not the NASDAQ line.
      case "ticker": return { text: row.ticker.metadata.ticker, note: canonicalExchange(row.ticker.metadata.exchange) || undefined, color: colors.textBright };
      case "name": return { text: row.ticker.metadata.name ?? "", color: colors.text };
      case "shares": return { text: positionsImportShares(row), color: colors.text, value: row.shares };
      case "cost": return { text: positionsImportCost(row), color: row.avgCost === null ? colors.textMuted : colors.text, value: row.avgCost };
      case "currency": return { text: row.currency, color: colors.textDim };
      case "bought": return { text: row.dateAcquired ?? "", color: colors.textDim };
      case "status": return { text: positionsImportStatus(row), color: row.heldShares === null ? colors.positive : colors.textDim };
    }
  }, [colors]);
  const renderSkipped = useCallback((row: SkippedFileRow, column: SkippedColumn): DataTableCell => {
    switch (column.id) {
      case "line": return { text: String(row.line), color: colors.textMuted, value: row.line };
      case "row": return { text: row.label, color: colors.text };
      case "reason": return { text: row.reason, color: colors.textDim };
    }
  }, [colors]);

  const contentWidth = desktop
    ? POSITIONS_IMPORT_DIALOG_COLUMNS
    : Math.max(20, Math.min(POSITIONS_IMPORT_DIALOG_COLUMNS, viewport.width - 2 - TERMINAL_DIALOG_INSET));
  // The terminal's scrollbar takes the body's last column; the tables stop short of it.
  const tableWidth = desktop ? contentWidth : contentWidth - TERMINAL_SCROLLBAR_COLUMNS;
  const withoutCost = plan?.rows.filter((row) => row.avgCost === null).map((row) => row.ticker.metadata.ticker) ?? [];
  const notices = plan ? [
    ...withoutCost.length > 0
      ? [tf("No cost in the file for {tickers}: set it with Set Portfolio Position after the import.", { tickers: withoutCost.join(", ") })]
      : [],
    ...plan.rows.flatMap((row) => row.notes.map((note) => `${row.ticker.metadata.ticker}: ${note}`)),
    ...plan.removed.length > 0 && !refusal ? [removedLine(plan.removed)] : [],
    ...plan.kept.length > 0 && !refusal ? [keptLine(plan.kept)] : [],
  ] : [];
  // A refused replace says why instead of what it would do.
  const headline = plan && !refusal ? planHeadline(plan, target, portfolio.name) : null;
  const status = lookupError ?? (plan && plan.rows.length === 0 ? t("None of the file's positions can be imported.") : refusal);
  const symbolCount = preview.file.positions.length;
  // Each table lists its first rows: a long one is drawn whole, row by row, and the rest are counted.
  const shownPositions = plan ? plan.rows.slice(0, PREVIEW_ROWS_SHOWN) : [];
  const morePositions = plan ? morePositionsLine(plan.rows.length) : null;
  const shownSkipped = plan ? plan.skipped.slice(0, PREVIEW_ROWS_SHOWN) : [];
  const moreSkipped = plan ? moreSkippedLine(plan.skipped.length) : null;

  const body = (
    <Box flexDirection="column">
      {!plan && !lookupError && (
        <Spinner label={symbolCount === 1 ? t("Looking up 1 symbol...") : tf("Looking up {count} symbols...", { count: symbolCount })} />
      )}
      {headline && <Text fg={colors.text} wrapText>{headline}</Text>}
      {status && <Notice tone="negative">{status}</Notice>}
      {plan && plan.rows.length > 0 && (
        <Box flexDirection="column" height={desktop ? undefined : tableRows(shownPositions.length)} marginTop={1}>
          <DataTableView<PositionsImportRow, PositionColumn>
            columns={positionColumns}
            items={shownPositions}
            selection={{ kind: "none" }}
            rootWidth={tableWidth}
            rootHeight={tableRows(shownPositions.length)}
            horizontalPadding={0}
            virtualize={false}
            fitRows
            sortColumnId={null}
            sortDirection="asc"
            getItemKey={(row) => row.ticker.metadata.ticker}
            renderCell={renderPosition}
            emptyStateTitle="Nothing to import"
          />
        </Box>
      )}
      {morePositions && <Text fg={colors.textMuted}>{morePositions}</Text>}
      {notices.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {notices.map((notice) => <Notice key={notice}>{notice}</Notice>)}
        </Box>
      )}
      {plan && plan.skipped.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <SectionHeading title={t("Skipped")} />
          <Box flexDirection="column" height={desktop ? undefined : tableRows(shownSkipped.length)}>
            <DataTableView<SkippedFileRow, SkippedColumn>
              columns={skippedColumns}
              items={shownSkipped}
              selection={{ kind: "none" }}
              rootWidth={tableWidth}
              rootHeight={tableRows(shownSkipped.length)}
              horizontalPadding={0}
              virtualize={false}
              fitRows
              sortColumnId={null}
              sortDirection="asc"
              getItemKey={(row) => `${row.line}:${row.label}`}
              renderCell={renderSkipped}
              emptyStateTitle="Nothing skipped"
            />
          </Box>
          {moreSkipped && <Text fg={colors.textMuted}>{moreSkipped}</Text>}
        </Box>
      )}
    </Box>
  );

  const targetControl = preview.existing ? (
    <Box flexDirection="column" marginBottom={1}>
      <Box height={1}><FieldLabel label={t("Import into")} active={!desktop} /></Box>
      <SegmentedControl
        accessibleLabel={t("Import into")}
        value={target}
        focused={!busy}
        shortcutScope={dialogId}
        allowEditable
        onChange={(next) => { if (!busy) setTarget(next as PositionsImportTarget); }}
        options={[
          { value: "new", label: tf("New portfolio \"{name}\"", { name: preview.newPortfolio.name }) },
          // An empty portfolio has nothing to merge with or replace: the file goes into it.
          ...preview.existing.holdings.length === 0
            ? [{ value: "merge", label: preview.existing.portfolio.name }]
            : [
              { value: "merge", label: tf("Merge into {name}", { name: preview.existing.portfolio.name }) },
              { value: "replace", label: tf("Replace {name}", { name: preview.existing.portfolio.name }) },
            ],
        ]}
      />
    </Box>
  ) : null;

  const importLabel = target === "replace" && plan && plan.rows.length > 0
    ? tf("Replace {held} with {count}", { held: heldCount, count: plan.rows.length })
    : plan && plan.rows.length > 0 ? tf("Import {count}", { count: positionsCount(plan.rows.length) }) : t("Import");
  const actions = (
    <DialogActions alignEnd hints={preview.existing ? { keys: [{ key: "←→", label: "target" }] } : undefined}>
      <Button label={t("Cancel")} variant="secondary" desktopShortcut="Esc" disabled={busy} onPress={() => resolve(false)} />
      <Button label={importLabel} variant="primary" desktopShortcut="Enter" disabled={!ready} pending={busy} onPress={() => { void submit(); }} />
    </DialogActions>
  );
  const subtitle = tf("From {source}", { source: preview.source });

  if (desktop) {
    return (
      <Box flexDirection="column" maxHeight={DESKTOP_MAX_HEIGHT} style={{ width: fitDialogWidth(POSITIONS_IMPORT_DIALOG_COLUMNS) }}>
        <DialogFrame title="Import Positions" subtitle={subtitle} desktopFooter={null} onClose={() => { if (!busy) resolve(false); }} shrinkable>
          {targetControl}
          <ScrollBox ref={scrollRef} scrollY style={{ overflowX: "hidden" }}>{body}</ScrollBox>
          {saveError && <Box style={{ marginTop: "var(--gloom-space-sm)" }}><Notice tone="negative">{saveError}</Notice></Box>}
          <Box style={{ marginTop: "var(--gloom-space-md)" }}>{actions}</Box>
        </DialogFrame>
      </Box>
    );
  }

  const noticeRows = notices.reduce((sum, notice) => sum + wrapTextLines(notice, contentWidth).length, 0);
  const bodyRows = (plan || lookupError ? 0 : 1)
    + (headline ? wrapTextLines(headline, contentWidth).length : 0)
    + (status ? wrapTextLines(status, contentWidth).length : 0)
    + (plan && plan.rows.length > 0 ? 1 + tableRows(shownPositions.length) + (morePositions ? 1 : 0) : 0)
    + (noticeRows > 0 ? 1 + noticeRows : 0)
    + (plan && plan.skipped.length > 0 ? 2 + tableRows(shownSkipped.length) + (moreSkipped ? 1 : 0) : 0);
  const fixedRows = TERMINAL_CHROME_ROWS + (targetControl ? 3 : 0) + (saveError ? 1 + wrapTextLines(saveError, contentWidth).length : 0);
  const shownRows = Math.max(1, Math.min(bodyRows, viewport.height - 2 - fixedRows));
  const keyLine = [
    ...preview.existing ? [t("←→ target")] : [],
    ...bodyRows > shownRows ? [t("↑↓ scroll")] : [],
    target === "replace" ? t("Enter replace") : t("Enter import"),
    t("Esc cancel"),
  ].join(" · ");
  return (
    <DialogFrame title="Import Positions" subtitle={subtitle} footer={keyLine}>
      <Box flexDirection="column" width={contentWidth}>
        {targetControl}
        <ScrollBox ref={scrollRef} height={shownRows} scrollY focusable={false}>{body}</ScrollBox>
        {saveError && (
          <>
            <Box height={1} />
            <Notice tone="negative">{saveError}</Notice>
          </>
        )}
        <Box height={1} />
        {actions}
      </Box>
    </DialogFrame>
  );
}
