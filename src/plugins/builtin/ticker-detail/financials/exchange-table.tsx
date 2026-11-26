import type { ReactNode } from "react";
import { DataTableView, ExternalLinkText, PaneLinkMenu, type DataTableColumn } from "../../../../components";
import { colors } from "../../../../theme/colors";
import type { TaiwanExchangeStatement } from "../../../../types/financials";
import { Box, Text, useUiCapabilities } from "../../../../ui";
import { formatDay } from "../../../../utils/day-format";

const formatAmount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });

export function ExchangeStatementTable({
  focused, statement, width, queryBar,
}: {
  focused: boolean;
  statement: TaiwanExchangeStatement;
  width: number;
  queryBar: ReactNode;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const { currency, source } = statement;
  const period = statement.kind === "income"
    ? `${statement.months} months ended ${formatDay(statement.periodEnd)}`
    : `As of ${formatDay(statement.periodEnd)}`;
  const publisher = source.venue === "TPEX" ? "TPEx" : "TWSE";
  const columns: DataTableColumn[] = [
    { id: "metric", label: "Metric", width: Math.max(18, Math.min(42, width - 23)), align: "left" },
    { id: "value", label: currency, width: 21, align: "right" },
  ];
  return (
    <PaneLinkMenu>
      <DataTableView
        focused={focused}
        items={statement.figures}
        columns={columns}
        selection={{ kind: "none" }}
        sortColumnId={null}
        sortDirection="desc"
        emptyStateTitle="No exchange figures"
        getItemKey={(row) => row.sourceLabel}
        columnReorder={false}
        renderCell={(row, column) => column.id === "metric"
          ? { text: row.perShare ? `${row.label} (per share)` : row.label }
          : { text: formatAmount.format(row.value), value: row.value }}
        getExportMetadata={() => [
          ["Period", period],
          ["Currency", currency],
          ["Exchange export date", source.snapshotDate],
          ["Source", source.url],
        ]}
        resetScrollKey={`${statement.kind}:${statement.periodEnd}`}
        showHorizontalScrollbar
        rootBefore={<>
          {queryBar}
          <Box flexDirection="row" flexWrap="wrap" gap={1} paddingX={nativePaneChrome ? 0 : 1}>
            <Text fg={colors.textDim}>{period}</Text>
            <ExternalLinkText url={source.url} label={`${publisher} export ${formatDay(source.snapshotDate)}`} />
          </Box>
        </>}
      />
    </PaneLinkMenu>
  );
}
