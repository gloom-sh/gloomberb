import { THEME_PERIODS } from "../../../api-client/themes";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchThemeMembers, fetchThemes } from "./client";
import { aggregateText, DEFAULT_SORT, matchTheme, memberPrice, percent, PERIOD_LABELS, sortMembers, sortThemes } from "./model";

const periods: HeadlessPaneColumn[] = THEME_PERIODS.map((key) => ({ key, header: PERIOD_LABELS[key], align: "right", format: (value) => percent(value as number | null) }));
export const themesHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  argument: { kind: "free-text", optional: true, placeholder: "theme", description: "Theme name or keyword, such as nuclear; omit for all themes." },
  options: [],
  discovery: { aliases: ["THEM"], dataRequirements: ["Gloom Cloud stored equity snapshot"],
    limitations: ["Updated every 15 minutes for Free and Pro", "Equal-weight price returns; missing observations reduce coverage", "Below half coverage a period is unavailable"] },
  describe: (args) => args.rawArgument ? `Thematic baskets | ${args.rawArgument}` : "Thematic baskets",
  async load(args, context) {
    const board = await fetchThemes(context.apiClient);
    const argument = Array.isArray(args.argument) ? args.argument.join(" ") : args.argument;
    if (argument) {
      const theme = matchTheme(board.themes, argument);
      if (!theme) throw new Error(`No theme matches ${argument}`);
      const data = await fetchThemeMembers(theme.id, context.apiClient);
      return { rows: sortMembers(data.members, DEFAULT_SORT).map((row) => ({ ...row })),
        columns: [{ key: "symbol", header: "Ticker" }, { key: "name", header: "Name" },
          { key: "price", header: "Price $", align: "right", format: (value) => memberPrice(value as number | null) }, ...periods],
        complete: !data.stale && data.members.every((row) => row.present && THEME_PERIODS.every((period) => row[period] !== null)),
        unavailableSymbols: data.members.filter((row) => !row.present).map((row) => row.symbol),
        metadata: { asOf: data.asOf, stale: data.stale, snapshotId: data.snapshotId, theme: data.theme } };
    }
    return { rows: sortThemes(board.themes, DEFAULT_SORT).map((row) => ({ name: row.name, memberCount: row.memberCount,
      ...Object.fromEntries(THEME_PERIODS.map((period) => [period, row.returns[period].value])), breadth: row.breadth.value, coverage: row.returns,
      breadthCoverage: row.breadth, best: row.best?.symbol ?? null, worst: row.worst?.symbol ?? null })),
      columns: [{ key: "name", header: "Theme" }, { key: "memberCount", header: "N", align: "right" },
        ...periods.map((column) => ({ ...column, format: (_value: unknown, row: Record<string, unknown>) => aggregateText((row.coverage as typeof board.themes[number]["returns"])[column.key as typeof THEME_PERIODS[number]]) })),
        { key: "breadth", header: "Breadth", align: "right", format: (_value, row) => aggregateText(row.breadthCoverage as typeof board.themes[number]["breadth"], true) },
        { key: "best", header: "Best 1D" }, { key: "worst", header: "Worst 1D" }],
      complete: !board.stale && board.themes.every((row) => THEME_PERIODS.every((period) => row.returns[period].covered === row.memberCount)),
      metadata: { asOf: board.asOf, stale: board.stale, snapshotId: board.snapshotId } };
  },
};
