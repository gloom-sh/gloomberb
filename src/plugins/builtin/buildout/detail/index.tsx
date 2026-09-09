import { Box, ScrollBox } from "../../../../ui";
import { EmptyState } from "../../../../components";
import type { BuildoutRow } from "../model/types";
import type { InlineTickerCatalog } from "./ui";
import {
  FavoriteCell,
} from "./ui";
import {
  favoriteKey,
  rowStarred,
} from "../table-model";
import { CompanyDetail } from "./company";
import { SiteDetail } from "./site";
import { IntelDetail } from "./intel";

export {
  CompaniesUpgradeCta,
  CompanyCell,
  FavoriteCell,
  tickerBadges,
} from "./ui";

export function BuildoutDetail({
  row,
  width,
  height,
  catalog,
  openTicker,
  canFavorite,
  favoriteBusyKey,
  onToggleFavorite,
}: {
  row: BuildoutRow | null;
  width: number;
  height: number;
  catalog: InlineTickerCatalog;
  openTicker: (symbol: string) => void;
  canFavorite: boolean;
  favoriteBusyKey: string | null;
  onToggleFavorite: (row: BuildoutRow) => void;
}) {
  if (!row) return <EmptyState title="No row selected." />;

  const bodyWidth = Math.max(width - 2, 20);
  const rowFavoriteKey = favoriteKey(row);
  const favoriteToggle = canFavorite && rowFavoriteKey ? (
    <FavoriteCell
      starred={rowStarred(row)}
      busy={favoriteBusyKey === rowFavoriteKey}
      selected={false}
      onPress={() => onToggleFavorite(row)}
    />
  ) : null;

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
          {row.kind === "company" ? (
            <CompanyDetail
              company={row.item}
              bodyWidth={bodyWidth}
              catalog={catalog}
              openTicker={openTicker}
              favoriteToggle={favoriteToggle}
            />
          ) : null}
          {row.kind === "site" ? (
            <SiteDetail
              site={row.item}
              bodyWidth={bodyWidth}
              height={height}
              catalog={catalog}
              openTicker={openTicker}
              favoriteToggle={favoriteToggle}
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
