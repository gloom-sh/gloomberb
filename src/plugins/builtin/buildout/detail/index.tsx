import { Box, ScrollBox } from "../../../../ui";
import { EmptyState, Notice } from "../../../../components";
import type { BuildoutRow } from "../model/types";
import type { InlineTickerCatalog } from "./ui";
import { CompanyDetail } from "./company";
import { SiteDetail } from "./site";
import { IntelDetail } from "./intel";

export {
  CompanyCell,
  FavoriteCell,
} from "./ui";

export function BuildoutDetail({
  row,
  note = null,
  width,
  height,
  catalog,
  openTicker,
}: {
  row: BuildoutRow | null;
  /** What the row's last star ran into, in full. */
  note?: string | null;
  width: number;
  height: number;
  catalog: InlineTickerCatalog;
  openTicker: (symbol: string) => void;
}) {
  if (!row) return <EmptyState title="No row selected." />;

  const bodyWidth = Math.max(width - 2, 20);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      minHeight={0}
      overflow="hidden"
    >
      <ScrollBox
        width={width}
        flexGrow={1}
        flexBasis={0}
        minHeight={0}
        scrollY
        focusable={false}
      >
        <Box flexDirection="column" paddingX={1} width={bodyWidth}>
          {note ? <Box paddingBottom={1}><Notice tone="negative">{note}</Notice></Box> : null}
          {row.kind === "company" ? (
            <CompanyDetail
              company={row.item}
              bodyWidth={bodyWidth}
              catalog={catalog}
              openTicker={openTicker}
            />
          ) : null}
          {row.kind === "site" ? (
            <SiteDetail
              site={row.item}
              bodyWidth={bodyWidth}
              height={height}
              catalog={catalog}
              openTicker={openTicker}
            />
          ) : null}
          {row.kind === "intel" ? (
            <IntelDetail
              item={row.item}
              bodyWidth={bodyWidth}
              height={height}
              catalog={catalog}
              openTicker={openTicker}
            />
          ) : null}
        </Box>
      </ScrollBox>
    </Box>
  );
}
