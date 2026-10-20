import { THEME_PERIODS, type ThemeMembersPayload, type ThemeSummary, type ThemesPayload } from "../../../api-client/themes";
import { EXTENDED_SESSION_LABELS, type ExtendedSession } from "../../../market-data/market/status";
import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneFreshness } from "../../../types/plugin";
import { formatRelativeAge } from "../../../utils/datetime-format";
import { fetchThemeMembers, fetchThemes } from "./client";
import {
  aggregateText, boardClose, boardYtdBase, DEFAULT_SORT, matchTheme, memberExtended, memberExtendedSessions, memberPrice, percent, periodLabel,
  SNAPSHOT_STALE_MS, sortMembers, sortThemes,
} from "./model";

/** The period columns; YTD names the close it is measured from, `YTD vs 31 Dec close`. */
const periodColumns = (payload: ThemesPayload | ThemeMembersPayload): HeadlessPaneColumn[] => {
  const base = boardYtdBase(payload);
  return THEME_PERIODS.map((key) => ({ key, header: periodLabel(key, base), align: "right", format: (value) => percent(value as number | null) }));
};

/** The pre-market or after-hours print and its move from the regular close in Price, for the members that have one. */
function extendedColumn(session: ExtendedSession): HeadlessPaneColumn {
  return {
    key: "extendedPrice",
    header: EXTENDED_SESSION_LABELS[session],
    align: "right",
    format: (value, row) => row.extendedSession === session && typeof value === "number"
      ? `${memberPrice(value)} ${percent(typeof row.extendedChangePercent === "number" ? row.extendedChangePercent : null)}`
      : "--",
  };
}

/**
 * When a board's figures are from. Outside the regular session they are the
 * completed session's close, so the report is as of that close (its date,
 * from a server that sends no close time), follows NYSE's sessions and says
 * how old the snapshot is, never dated by when the snapshot was put together.
 * A snapshot over 30 minutes old is the news: the report is then dated by it
 * and reads stale, as it does while a session trades and from a server that
 * does not name the close. The snapshot's own time and age ride along.
 */
function boardObservation(payload: ThemesPayload | ThemeMembersPayload, now = Date.now()): {
  metadata: Record<string, unknown>;
  freshness: HeadlessPaneFreshness;
} {
  const assembledAt = Date.parse(payload.asOf);
  const close = boardClose(payload);
  const snapshot = {
    snapshotId: payload.snapshotId,
    stale: payload.stale,
    snapshotAssembledAt: payload.asOf,
    snapshotAgeMinutes: Math.max(0, Math.floor((now - assembledAt) / 60_000)),
    session: payload.session ?? null,
    regularSessionDate: close?.date ?? null,
    regularSessionClosedAt: close?.closedAt ?? null,
  };
  if (close && now - assembledAt <= SNAPSHOT_STALE_MS) {
    return {
      metadata: { asOf: close.closedAt != null ? new Date(close.closedAt).toISOString() : close.date, sessionExchange: "NYSE", ...snapshot },
      freshness: { tradingDayMarket: "US", note: `snapshot ${formatRelativeAge(assembledAt, now)}` },
    };
  }
  return { metadata: { asOf: payload.asOf, ...snapshot }, freshness: { maxAgeMinutes: 30 } };
}

/**
 * The report title names the basket shown, and the word that matched it when
 * that is not the basket's own name: `Thematic baskets | Critical minerals
 * (matched lithium)`, since there is no lithium basket.
 */
function themeReportTitle(query: string | undefined, theme: Pick<ThemeSummary, "id" | "name"> | undefined): string {
  const typed = query?.trim();
  if (!typed) return "Thematic baskets";
  if (!theme) return `Thematic baskets | ${typed}`;
  const named = [theme.id, theme.name].some((label) => label.toLowerCase() === typed.toLowerCase());
  return `Thematic baskets | ${theme.name}${named ? "" : ` (matched ${typed})`}`;
}

export const themesHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  // The pane's stored snapshot: 15-minute delayed prices, refreshed every 15 minutes. As in the pane,
  // the payload's stale flags are historical; a snapshot over 30 minutes old is what reads stale
  // (boardObservation, which dates a board outside the regular session by its close).
  freshness: { status: "delayed", delayMinutes: 15, ignoreStaleFlags: true },
  argument: { kind: "free-text", optional: true, placeholder: "theme", description: "Theme name or keyword, such as nuclear; omit for all themes." },
  options: [],
  discovery: { aliases: ["THEM"], dataRequirements: ["Gloom Cloud stored equity snapshot"],
    limitations: ["Updated every 15 minutes for Free and Pro.", "Equal-weight price returns; missing observations reduce coverage.", "Below half coverage a period is unavailable.",
      "Outside the regular session Price, 1D and the returns end at the last regular close; a pre-market or after-hours print is shown beside it and never enters them."] },
  describe: (args, result) => themeReportTitle(args.rawArgument, (result?.metadata as { theme?: ThemeSummary } | undefined)?.theme),
  async load(args, context) {
    const board = await fetchThemes(context.apiClient);
    const argument = Array.isArray(args.argument) ? args.argument.join(" ") : args.argument;
    if (argument) {
      const theme = matchTheme(board.themes, argument);
      if (!theme) throw new Error(`No theme matches ${argument}. Themes: ${board.themes.map((row) => row.name).join(", ")}.`);
      const data = await fetchThemeMembers(theme.id, context.apiClient);
      const observation = boardObservation(data);
      // Price and 1D are the regular session's; an extended print gets a column only when a member has one.
      const extendedSessions = memberExtendedSessions(data.members);
      const periods = periodColumns(data);
      return { rows: sortMembers(data.members, DEFAULT_SORT).map((row) => {
        const extended = memberExtended(row);
        return { ...row, extendedSession: extended?.session ?? null, extendedPrice: extended?.price ?? null,
          extendedChange: extended?.change ?? null, extendedChangePercent: extended?.changePercent ?? null };
      }),
        columns: [{ key: "symbol", header: "Ticker" }, { key: "name", header: "Name" },
          { key: "price", header: "Price $", align: "right", format: (value) => memberPrice(value as number | null) },
          periods[0]!, ...extendedSessions.map(extendedColumn), ...periods.slice(1)],
        complete: !data.stale && data.members.every((row) => row.present && THEME_PERIODS.every((period) => row[period] !== null)),
        unavailableSymbols: data.members.filter((row) => !row.present).map((row) => row.symbol),
        freshness: observation.freshness,
        metadata: { ...observation.metadata, theme: data.theme } };
    }
    const observation = boardObservation(board);
    const periods = periodColumns(board);
    return { rows: sortThemes(board.themes, DEFAULT_SORT).map((row) => ({ name: row.name, memberCount: row.memberCount,
      ...Object.fromEntries(THEME_PERIODS.map((period) => [period, row.returns[period].value])), breadth: row.breadth.value, coverage: row.returns,
      breadthCoverage: row.breadth, best: row.best?.symbol ?? null, worst: row.worst?.symbol ?? null })),
      columns: [{ key: "name", header: "Theme" }, { key: "memberCount", header: "N", align: "right" },
        ...periods.map((column) => ({ ...column, format: (_value: unknown, row: Record<string, unknown>) => aggregateText((row.coverage as typeof board.themes[number]["returns"])[column.key as typeof THEME_PERIODS[number]]) })),
        { key: "breadth", header: "Breadth", align: "right", format: (_value, row) => aggregateText(row.breadthCoverage as typeof board.themes[number]["breadth"], true) },
        { key: "best", header: "Best 1D" }, { key: "worst", header: "Worst 1D" }],
      complete: !board.stale && board.themes.every((row) => THEME_PERIODS.every((period) => row.returns[period].covered === row.memberCount)),
      freshness: observation.freshness,
      metadata: observation.metadata };
  },
};
